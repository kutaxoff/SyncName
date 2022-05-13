
import fs from 'fs';
import { copySync } from 'fs-extra';
import path, { ParsedPath } from 'path';
import klawSync from 'klaw-sync';
import Multiprogress from 'multi-progress';

import minimist, { ParsedArgs } from 'minimist'

// #region File Types and Operations

type SyncPredicate = (source: ParsedFile, target: ParsedFile) => boolean;

interface SyncResults {
    resolved: ParsedFile[];
    collisions: Map<ParsedFile, ParsedFile[]>;
}

class ParsedFile implements ParsedPath {
    public root: string;
    public dir: string;
    public name: string;
    public ext: string;

    public get base() {
        return this.name + this.ext;
    }

    public get fullPath() {
        return path.format(this);
    }

    public withName(n: string): ParsedFile {
        const newFile = new ParsedFile(this.fullPath);
        newFile.name = n;
        return newFile;
    }

    public withParentDirectory(d: string): ParsedFile {
        const newFile = new ParsedFile(this.fullPath);
        newFile.dir = path.join(d, this.dir);
        return newFile;
    }

    public relativeTo(d: string): ParsedFile {
        const newFile = new ParsedFile(this.fullPath);
        newFile.dir = path.relative(d, this.dir);
        return newFile;
    }

    public equal(f: ParsedFile) {
        return this.fullPath === f.fullPath;
    }

    constructor(p: string) {
        const parsed = path.parse(p);
        this.root = parsed.root;
        this.dir = parsed.dir;
        this.name = parsed.name;
        this.ext = parsed.ext;
    }
}

let renameFile = (file: ParsedFile, newName: string) => {
    if (file.name !== newName) {
        const newFile = file.withName(newName);
        fs.renameSync(file.fullPath, newFile.fullPath);
    }
}

let copyFile = (sourceFile: ParsedFile, targetFile: ParsedFile) => {
    fs.copyFileSync(sourceFile.fullPath, targetFile.fullPath);
}

// #endregion

// #region Sync Logic

function syncDir(
    sourceDir: string,
    targetDir: string,
    areSyncable: SyncPredicate,
    syncResults?: SyncResults,
    onProgressCallback?: (message: string) => void,
): SyncResults {
    const { resolved, collisions } = {
        resolved: [],
        collisions: new Map<ParsedFile, ParsedFile[]>(),
        ...syncResults,
    }

    const sourceFiles = fs.readdirSync(sourceDir, { withFileTypes: true })
        .filter(dirent => dirent.isFile() && dirent.name !== '.DS_Store')
        .map(dirent => new ParsedFile(dirent.name));

    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir);
    }
    const targetFiles = fs.readdirSync(targetDir, { withFileTypes: true })
        .filter(dirent => dirent.isFile() && dirent.name !== '.DS_Store')
        .map(dirent => new ParsedFile(dirent.name));

    sourceFiles.forEach(
        sourceFile => {
            const targetCandidates = targetFiles
                .filter(candidate => areSyncable(sourceFile, candidate))
                .map(candidate => candidate.withParentDirectory(targetDir))
                .filter(candidate => !resolved.find(file => file.equal(candidate)));

            if (targetCandidates.length === 1) {
                resolved.push(targetCandidates[0]);
                renameFile(targetCandidates[0], sourceFile.name);
            } else if (targetCandidates.length > 1) {
                collisions.set(sourceFile.withParentDirectory(sourceDir), targetCandidates);
            } else {
                copyFile(sourceFile.withParentDirectory(sourceDir), sourceFile.withParentDirectory(targetDir));
            }
            onProgressCallback?.(sourceFile.withParentDirectory(sourceDir).fullPath);
        }
    )
    return {
        resolved,
        collisions,
    }
}

function syncNames(
    sourceRoot: string,
    targetRoot: string,
    syncPredicate: SyncPredicate,
    onProgressCallback?: (message: string) => void,
) {
    let syncResults = syncDir(
        sourceRoot,
        targetRoot,
        syncPredicate,
        undefined,
        onProgressCallback,
    );

    klawSync(sourceRoot, { nofile: true }).map(
        dir => path.relative(sourceRoot, dir.path),
    ).forEach(
        dir => {
            syncResults = syncDir(
                path.join(sourceRoot, dir),
                path.join(targetRoot, dir),
                syncPredicate,
                syncResults,
                onProgressCallback,
            );
        },
    );
    return syncResults;
}

function resolveCollisions(
    sourceRoot: string,
    targetRoot: string,
    collisions: Map<ParsedFile, ParsedFile[]>,
    postfix = '',
    onProgressCallback?: (message: string) => void,
) {
    postfix = ' ' + postfix;
    const toRename = new Map<ParsedFile, string>();
    const toCopy = new Map<ParsedFile, ParsedFile>();
    const byNameLenDesc = (a: ParsedFile, b: ParsedFile) => b.name.length - a.name.length;

    [...collisions.keys()]
        .sort(byNameLenDesc)
        .forEach(sourceFile => {
            const fileToRename = collisions.get(sourceFile)!
                .filter(candidate => ![...toRename.keys()].find(file => file.equal(candidate)))
                .sort(byNameLenDesc)
            [0]
            if (fileToRename) {
                toRename.set(fileToRename, sourceFile.name);
            } else {
                toCopy.set(sourceFile, sourceFile.relativeTo(sourceRoot).withParentDirectory(targetRoot));
            }
        })
    toRename.forEach((name, file) => {
        renameFile(file, name + postfix);
        onProgressCallback?.(file.fullPath);
    })
    toCopy.forEach((target, source) => {
        copyFile(source, target.withName(target.name + postfix));
        onProgressCallback?.(source.fullPath);
    })
}

// #endregion

// #region App Utils

interface SyncConfig {
    targetRoot: string;
    sourceRoot: string;
    collisionPostfix: string;
    withBar: boolean;
    fake: boolean;
    barDelay: number;
}

function handleError(error: any) {
    console.error(error);
    process.exit(1);
}

function applyArgv(argv: ParsedArgs): SyncConfig {
    if (argv.help || argv.h || argv._.includes('help')) {
        console.log('\nARGS: -s <SOURCE_DIR> -t <TARGET_DIR> [-b <BACKUP_DIR>] [-p <COLLISIONS_POSTFIX>]\n');
        process.exit();
    }
    const targetRoot = argv.t;
    const sourceRoot = argv.s;

    if (!(sourceRoot && targetRoot)) {
        handleError('\nPlease provide source (-s) and target (-t) directories\n');
    }

    const collisionPostfix = argv.p ? argv.p : '$collision$';

    if (argv.b) {
        try {
            copySync(targetRoot, argv.b, { overwrite: true });
            console.log('Backup created');
        } catch (error) {
            handleError(error);
        }
    }
    let fakeSync = !!argv.fake;
    let fakeWithBar = !!argv.bar;

    return {
        targetRoot,
        sourceRoot,
        collisionPostfix,
        withBar: fakeWithBar || !fakeSync,
        fake: fakeSync,
        barDelay: typeof argv.delay === 'number' ? argv.delay : 0,
    }
}

function checkAccess(targetRoot: string, sourceRoot: string) {
    try {
        fs.accessSync(targetRoot, fs.constants.W_OK | fs.constants.R_OK)
    } catch (error) {
        handleError('\nNo write access to target directory\n');
    }

    try {
        fs.accessSync(sourceRoot, fs.constants.R_OK)
    } catch (error) {
        handleError('\nNo read access to source directory\n');
    }

}

function sleep(milliseconds = 0) {
    if (!milliseconds) {
        return;
    }
    const date = Date.now();
    let currentDate = null;
    do {
        currentDate = Date.now();
    } while (currentDate - date < milliseconds);
}

// #endregion

const syncRegex = /[^a-zA-Z0-9]+/g;

function areSyncable(sourceFile: ParsedFile, targetFile: ParsedFile) {
    const sourceNameClean = sourceFile.name.replace(syncRegex, '');
    const targetNameClean = targetFile.name.replace(syncRegex, '');
    return sourceNameClean.startsWith(targetNameClean);
}

let renameFileMock = (file: ParsedFile, newName: string) => {
    if (file.name !== newName) {
        const newFile = file.withName(newName);
        console.log(file.fullPath, '-->', newFile.fullPath);
    }
}

let copyFileMock = (sourceFile: ParsedFile, targetFile: ParsedFile) => {
    console.log('Copy:', sourceFile.fullPath, '-->', targetFile.fullPath);
}

function main() {
    const argv = minimist(process.argv.slice(2));
    const { targetRoot, sourceRoot, collisionPostfix, withBar, fake, barDelay } = applyArgv(argv);

    checkAccess(targetRoot, sourceRoot);

    const totalFilesCount = klawSync(sourceRoot, { nodir: true })
        .filter(file => !file.path.includes('.DS_Store'))
        .length
    console.log('\nFiles detected (source):', totalFilesCount, '\n');

    const multi = new Multiprogress(process.stdout);

    console.log('Processed:');
    const bar = multi.newBar(':bar :current/:total :percent ETA: :etas', { total: totalFilesCount, width: 40 });
    const currentFileBar = multi.newBar(':filepath', { total: totalFilesCount + 1, clear: true });

    const syncBarTick = (filepath: string) => {
        sleep(barDelay);
        currentFileBar.tick({
            filepath,
        });
        bar.tick();
    }

    if (fake) {
        if (withBar) {
            renameFile = () => { };
            copyFile = () => { };
        } else {
            renameFile = renameFileMock;
            copyFile = copyFileMock;
        }
    }

    const results = syncNames(sourceRoot, targetRoot, areSyncable, withBar ? syncBarTick : undefined);

    if (withBar) {
        currentFileBar.tick({
            filepath: '',
        })
    }
    console.log('Collisions found:', results.collisions.size, '\n');

    if (results.collisions.size) {
        console.log(`Resolved (with postfix ${collisionPostfix}):`);
        const collisionsBar = multi.newBar(':bar :current/:total :percent ETA: :etas', { total: results.collisions.size, width: 40 });

        const collisionsBarTick = () => {
            sleep(barDelay);
            collisionsBar.tick();
        }

        resolveCollisions(sourceRoot, targetRoot, results.collisions, collisionPostfix, withBar ? collisionsBarTick : undefined);
    }

    console.log('Synchronization completed!\n');
}

main();
