/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import fs = require('fs');
import paths = require('path');

import scorer = require('vs/base/common/scorer');
import arrays = require('vs/base/common/arrays');
import strings = require('vs/base/common/strings');
import types = require('vs/base/common/types');
import glob = require('vs/base/common/glob');
import {IProgress, ISearchStats} from 'vs/platform/search/common/search';

import extfs = require('vs/base/node/extfs');
import flow = require('vs/base/node/flow');
import {ISerializedFileMatch, ISerializedSearchComplete, IRawSearch, ISearchEngine} from './search';

export class FileWalker {
	private config: IRawSearch;
	private filePattern: string;
	private normalizedFilePatternLowercase: string;
	private excludePattern: glob.IExpression;
	private includePattern: glob.IExpression;
	private maxResults: number;
	private maxFilesize: number;
	private isLimitHit: boolean;
	private resultCount: number;
	private isCanceled: boolean;
	private fileWalkStartTime: number;
	private directoriesWalked: number;
	private filesWalked: number;

	private walkedPaths: { [path: string]: boolean; };

	private throttler = new IOThrottler();

	constructor(config: IRawSearch) {
		this.config = config;
		this.filePattern = config.filePattern;
		this.excludePattern = config.excludePattern;
		this.includePattern = config.includePattern;
		this.maxResults = config.maxResults || null;
		this.maxFilesize = config.maxFilesize || null;
		this.walkedPaths = Object.create(null);
		this.resultCount = 0;
		this.isLimitHit = false;
		this.directoriesWalked = 0;
		this.filesWalked = 0;

		if (this.filePattern) {
			this.filePattern = this.filePattern.replace(/\\/g, '/'); // Normalize file patterns to forward slashes
			this.normalizedFilePatternLowercase = strings.stripWildcards(this.filePattern).toLowerCase();
		}
	}

	public cancel(): void {
		this.isCanceled = true;
	}

	public walk(rootFolders: string[], extraFiles: string[], onResult: (result: ISerializedFileMatch, size: number) => void, done: (error: Error, isLimitHit: boolean) => void): void {
		this.fileWalkStartTime = Date.now();

		// Support that the file pattern is a full path to a file that exists
		this.checkFilePatternAbsoluteMatch((exists, size) => {
			if (this.isCanceled) {
				return done(null, this.isLimitHit);
			}

			// Report result from file pattern if matching
			if (exists) {
				onResult({ path: this.filePattern }, size);

				// Optimization: a match on an absolute path is a good result and we do not
				// continue walking the entire root paths array for other matches because
				// it is very unlikely that another file would match on the full absolute path
				return done(null, this.isLimitHit);
			}

			// For each extra file
			if (extraFiles) {
				extraFiles.forEach(extraFilePath => {
					if (glob.match(this.excludePattern, extraFilePath)) {
						return; // excluded
					}

					// File: Check for match on file pattern and include pattern
					this.matchFile(onResult, extraFilePath, extraFilePath /* no workspace relative path */);
				});
			}

			// For each root folder
			flow.parallel(rootFolders, (absolutePath, perEntryCallback) => {
				this.directoriesWalked++;
				this.throttler.run(cont => extfs.readdir(absolutePath, (error: Error, files: string[]) => {
					cont();
					if (error || this.isCanceled || this.isLimitHit) {
						return perEntryCallback(null, null);
					}

					// Support relative paths to files from a root resource
					return this.checkFilePatternRelativeMatch(absolutePath, (match, size) => {
						if (this.isCanceled || this.isLimitHit) {
							return perEntryCallback(null, null);
						}

						// Report result from file pattern if matching
						if (match) {
							onResult({ path: match }, size);
						}

						return this.doWalk(paths.normalize(absolutePath), '', files, onResult, perEntryCallback);
					});
				}), 'readdir');
			}, (err, result) => {
				done(err ? err[0] : null, this.isLimitHit);
			});
		});
	}

	public getStats(): ISearchStats {
		return {
			fileWalkStartTime: this.fileWalkStartTime,
			fileWalkResultTime: Date.now(),
			directoriesWalked: this.directoriesWalked,
			filesWalked: this.filesWalked
		};
	}

	private checkFilePatternAbsoluteMatch(clb: (exists: boolean, size?: number) => void): void {
		if (!this.filePattern || !paths.isAbsolute(this.filePattern)) {
			return clb(false);
		}

		return this.throttler.run(cont => fs.stat(this.filePattern, (error, stat) => {
			cont();
			return clb(!error && !stat.isDirectory(), stat && stat.size); // only existing files
		}));
	}

	private checkFilePatternRelativeMatch(basePath: string, clb: (matchPath: string, size?: number) => void): void {
		if (!this.filePattern || paths.isAbsolute(this.filePattern)) {
			return clb(null);
		}

		const absolutePath = paths.join(basePath, this.filePattern);

		return this.throttler.run(cont => fs.stat(absolutePath, (error, stat) => {
			cont();
			return clb(!error && !stat.isDirectory() ? absolutePath : null, stat && stat.size); // only existing files
		}));
	}

	private doWalk(absolutePath: string, relativeParentPathWithSlashes: string, files: string[], onResult: (result: ISerializedFileMatch, size: number) => void, done: (error: Error, result: any) => void): void {

		// Execute tasks on each file in parallel to optimize throughput
		flow.parallel(files, (file: string, clb: (error: Error) => void): void => {

			// Check canceled
			if (this.isCanceled || this.isLimitHit) {
				return clb(null);
			}

			// If the user searches for the exact file name, we adjust the glob matching
			// to ignore filtering by siblings because the user seems to know what she
			// is searching for and we want to include the result in that case anyway
			let siblings = files;
			if (this.config.filePattern === file) {
				siblings = [];
			}

			// Check exclude pattern
			let currentRelativePathWithSlashes = relativeParentPathWithSlashes ? [relativeParentPathWithSlashes, file].join('/') : file;
			if (glob.match(this.excludePattern, currentRelativePathWithSlashes, siblings)) {
				return clb(null);
			}

			// Use lstat to detect links
			let currentAbsolutePath = [absolutePath, file].join(paths.sep);
			this.throttler.run(cont => fs.lstat(currentAbsolutePath, (error, lstat) => {
				cont();
				if (error || this.isCanceled || this.isLimitHit) {
					return clb(null);
				}

				// If the path is a link, we must instead use fs.stat() to find out if the
				// link is a directory or not because lstat will always return the stat of
				// the link which is always a file.
				this.statLinkIfNeeded(currentAbsolutePath, lstat, (error, stat) => {
					if (error || this.isCanceled || this.isLimitHit) {
						return clb(null);
					}

					// Directory: Follow directories
					if (stat.isDirectory()) {
						this.directoriesWalked++;

						// to really prevent loops with links we need to resolve the real path of them
						return this.realPathIfNeeded(currentAbsolutePath, lstat, (error, realpath) => {
							if (error || this.isCanceled || this.isLimitHit) {
								return clb(null);
							}

							if (this.walkedPaths[realpath]) {
								return clb(null); // escape when there are cycles (can happen with symlinks)
							}

							this.walkedPaths[realpath] = true; // remember as walked

							// Continue walking
							return this.throttler.run(cont => extfs.readdir(currentAbsolutePath, (error: Error, children: string[]): void => {
								cont();
								if (error || this.isCanceled || this.isLimitHit) {
									return clb(null);
								}

								this.doWalk(currentAbsolutePath, currentRelativePathWithSlashes, children, onResult, clb);
							}), 'readdir');
						});
					}

					// File: Check for match on file pattern and include pattern
					else {
						this.filesWalked++;
						if (currentRelativePathWithSlashes === this.filePattern) {
							return clb(null); // ignore file if its path matches with the file pattern because checkFilePatternRelativeMatch() takes care of those
						}

						if (this.maxFilesize && types.isNumber(stat.size) && stat.size > this.maxFilesize) {
							return clb(null); // ignore file if max file size is hit
						}

						this.matchFile(onResult, currentAbsolutePath, currentRelativePathWithSlashes, stat.size);
					}

					// Unwind
					return clb(null);
				});
			}));
		}, (error: Error[]): void => {
			if (error) {
				error = arrays.coalesce(error); // find any error by removing null values first
			}

			return done(error && error.length > 0 ? error[0] : null, null);
		});
	}

	private matchFile(onResult: (result: ISerializedFileMatch, size: number) => void, absolutePath: string, relativePathWithSlashes: string, size?: number): void {
		if (this.isFilePatternMatch(relativePathWithSlashes) && (!this.includePattern || glob.match(this.includePattern, relativePathWithSlashes))) {
			// if (this.resultCount % 500 === 0) {
			// 	console.log(JSON.stringify({
			// 		sinceFileWalkStarted: Date.now() - this.fileWalkStartTime,
			// 		results: this.resultCount,
			// 		dirs: this.directoriesWalked,
			// 		files: this.filesWalked
			// 	}).replace(/"/g, ''));
			// }
			this.resultCount++;

			if (this.maxResults && this.resultCount > this.maxResults) {
				this.isLimitHit = true;
			}

			if (!this.isLimitHit) {
				onResult({
					path: absolutePath
				}, size);
			}
		}
	}

	private isFilePatternMatch(path: string): boolean {

		// Check for search pattern
		if (this.filePattern) {
			if (this.filePattern === '*') {
				return true; // support the all-matching wildcard
			}

			return scorer.matches(path, this.normalizedFilePatternLowercase);
		}

		// No patterns means we match all
		return true;
	}

	private statLinkIfNeeded(path: string, lstat: fs.Stats, clb: (error: Error, stat: fs.Stats) => void): void {
		if (lstat.isSymbolicLink()) {
			// stat the target the link points to
			return this.throttler.run(cont => fs.stat(path, (error, stat) => {
				cont();
				clb(error, stat);
			}));
		}

		return clb(null, lstat); // not a link, so the stat is already ok for us
	}

	private realPathIfNeeded(path: string, lstat: fs.Stats, clb: (error: Error, realpath?: string) => void): void {
		if (lstat.isSymbolicLink()) {
			return this.throttler.run(cont => fs.realpath(path, (error, realpath) => {
				cont();
				return clb(error, realpath);
			}));
		}

		return clb(null, path);
	}
}

export class Engine implements ISearchEngine {
	private rootFolders: string[];
	private extraFiles: string[];
	private walker: FileWalker;

	constructor(config: IRawSearch) {
		this.rootFolders = config.rootFolders;
		this.extraFiles = config.extraFiles;

		this.walker = new FileWalker(config);
	}

	public search(onResult: (result: ISerializedFileMatch) => void, onProgress: (progress: IProgress) => void, done: (error: Error, complete: ISerializedSearchComplete) => void): void {
		this.walker.walk(this.rootFolders, this.extraFiles, onResult, (err: Error, isLimitHit: boolean) => {
			done(err, {
				limitHit: isLimitHit,
				stats: this.walker.getStats()
			});
		});
	}

	public cancel(): void {
		this.walker.cancel();
	}
}

type Enqueue = (cont: () => void) => void;

class IOThrottler {

	constructor() {
		// setInterval(() => {
		// 	// console.log(`q${this.queues2.map(q => q.length)}, a${this.active2.map(q => q.length)}`);
		// 	// console.log(`q${this.queues.map(q => q.length)}, a${this.active.length}`);
		// 	console.log(`q${this.length3}, a${this.active3.length}`);
		// }, 1000);
	}

	public run = this.run1;

	public run0(enqueue?: Enqueue) {
		enqueue(() => {});
	}

	private static MAX = 10;
	private static LOW = 0;
	private queues = [[], []];
	private active = [];

	public run1(enqueue?: Enqueue, op?: string) {
		if (enqueue) {
			this.queues[op === 'readdir' ? 1 : 0].push(enqueue);
		}
		while ((this.queues[0].length || this.queues[1].length) && this.active.length < IOThrottler.MAX) {
			const i = (this.queues[0].length < IOThrottler.LOW && this.queues[1].length || !this.queues[0].length) ? 1 : 0;
			const activate = this.queues[i].shift();
			execute(this.active, activate, () => this.run());
		}
	}

	private static MAX2 = [10, 5];
	private static LOW2 = 10;
	private queues2 = [[], []];
	private active2 = [[], []];

	public run2(enqueue?: Enqueue, op?: string) {
		if (enqueue) {
			this.queues2[op === 'readdir' ? 1 : 0].push(enqueue);
		}
		for (let i = 0; i < 2; i++) {
			while (this.queues2[i].length && this.active2[i].length < IOThrottler.MAX2[i] && (i === 0 || this.queues2[0].length < IOThrottler.LOW2)) {
				const activate = this.queues2[i].shift();
				execute(this.active2[i], activate, () => this.run());
			}
		}
	}

	private static MAX3 = 10;
	private head3 = [];
	private tail3 = this.head3;
	private empty3 = this.tail3;
	private length3 = 0;
	private active3 = [];

	public run3(enqueue?: Enqueue, op?: string) {
		if (enqueue) {
			const last = this.tail3;
			last[0] = enqueue;
			if (!last[1]) {
				last[1] = [];
				this.empty3 = last[1];
			}
			this.tail3 = last[1];
			this.length3++;
		}
		while (this.head3[0] && this.active3.length < IOThrottler.MAX3) {
			const activate = this.head3[0];
			const old = this.head3;
			this.head3 = this.head3[1];
			old.length = 0;
			this.empty3[1] = old;
			this.empty3 = old;
			this.length3--;
			execute(this.active3, activate, () => this.run());
		}
	}

	// private static MAX3 = 10;
	// private queue3 = [];
	// private active3 = [];

	// public run3(enqueue?: Enqueue, op?: string) {
	// 	if (enqueue) {
	// 		this.queue3.push(enqueue);
	// 	}
	// 	while (this.queue3.length && this.active3.length < IOThrottler.MAX3) {
	// 		const activate = this.queue3.shift();
	// 		execute(this.active3, activate, () => this.run());
	// 	}
	// }
}

function execute(active: Enqueue[], activate: Enqueue, cont: () => void) {
	activate(() => {
		active.splice(active.indexOf(activate), 1);
		cont();
	});
	active.push(activate);
}