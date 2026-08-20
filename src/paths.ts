import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

/**
 * A tool argument tried to reach a file outside the directories this server is
 * allowed to touch. Separate from the paperless-side errors so `handle` can
 * surface the message on its own.
 */
export class PathError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PathError';
    }
}

/** True when `target` is `root` itself or sits underneath it. */
export function isWithin(root: string, target: string): boolean {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function describe(roots: string[]): string {
    return roots.length === 1 ? roots[0] : roots.join(', ');
}

/**
 * Resolves a caller-supplied path against `root` and refuses anything landing
 * outside it. A relative path is taken relative to `root` rather than the
 * process cwd, so a bare filename always means "in the download directory".
 *
 * This is the cheap, no-syscall half of the check; symlinks are handled by
 * {@link prepareWriteTarget} once the directories actually exist.
 */
export function resolveWithin(root: string, candidate: string, label: string): string {
    const resolvedRoot = path.resolve(root);
    const target = path.resolve(resolvedRoot, candidate);
    if (!isWithin(resolvedRoot, target)) {
        throw new PathError(
            `${label} must stay inside ${resolvedRoot}, but ${target} is outside it. ` +
                'Point PAPERLESS_DOWNLOAD_DIR at the directory you want files written to.',
        );
    }
    return target;
}

/**
 * Creates `dir` if needed, private to this user, and refuses to use it when the
 * directory itself is a symlink — otherwise anyone able to write to a shared
 * temp directory could pre-plant one and redirect every download.
 */
export async function ensureDirectory(dir: string): Promise<void> {
    const resolved = path.resolve(dir);
    await mkdir(resolved, { recursive: true, mode: 0o700 });
    const stats = await lstat(resolved);
    if (stats.isSymbolicLink()) {
        throw new PathError(`Refusing to use ${resolved}: it is a symlink. Set PAPERLESS_DOWNLOAD_DIR to a real directory.`);
    }
}

/**
 * Makes `target`'s parent directory and confirms the write really lands inside
 * `root`. `resolveWithin` can only compare the paths as written; this re-checks
 * after resolving symlinks, which is what catches a linked intermediate
 * directory or a pre-planted link sitting at the target itself.
 *
 * Returns the logical path to write to — the same file as the resolved one, but
 * the name the caller asked for, which is friendlier to report back.
 */
export async function prepareWriteTarget(root: string, target: string): Promise<string> {
    const resolvedRoot = path.resolve(root);
    await ensureDirectory(resolvedRoot);

    const parent = path.dirname(target);
    await mkdir(parent, { recursive: true, mode: 0o700 });

    const [realRoot, realParent] = await Promise.all([realpath(resolvedRoot), realpath(parent)]);
    if (!isWithin(realRoot, realParent)) {
        throw new PathError(`Refusing to write to ${target}: it resolves to ${realParent}, outside ${realRoot}.`);
    }

    const existing = await lstat(target).catch(() => null);
    if (existing?.isSymbolicLink()) {
        throw new PathError(`Refusing to write through the symlink at ${target}.`);
    }

    return target;
}

/**
 * Checks a file the caller wants uploaded against the allowlist of directories
 * this server may read from, following symlinks so a link inside an allowed
 * directory cannot pull in `~/.ssh/id_rsa`.
 *
 * A missing file passes: the open that follows reports it far better than a
 * path check can.
 */
export async function resolveReadable(roots: string[], candidate: string): Promise<string> {
    const target = path.resolve(candidate);
    const resolvedRoots = roots.map((root) => path.resolve(root));
    const realRoots = await Promise.all(resolvedRoots.map((root) => realpath(root).catch(() => root)));

    const allowed = (probe: string) =>
        resolvedRoots.some((root) => isWithin(root, probe)) || realRoots.some((root) => isWithin(root, probe));

    if (!allowed(target)) {
        throw new PathError(
            `Refusing to upload ${target}: this server may only read from ${describe(resolvedRoots)}. ` +
                'Set PAPERLESS_UPLOAD_DIRS to allow other directories.',
        );
    }

    const real = await realpath(target).catch(() => null);
    if (real !== null && !allowed(real)) {
        throw new PathError(
            `Refusing to upload ${target}: it is a link to ${real}, outside ${describe(resolvedRoots)}.`,
        );
    }

    return target;
}
