// To preserve the effects of https://github.com/microsoft/TypeScript/pull/55326
// this file needs to avoid importing large graphs.

// Types of the Yarn PnP API, from https://yarnpkg.com/advanced/pnpapi
/* eslint-disable no-restricted-syntax */

/** Identifies a package by its name and reference (the resolved version, such as `npm:1.0.0` or `workspace:packages/lib`). */
export interface PnpPackageLocator {
    name: string;
    reference: string;
}

/** Locator of the top-level package, standing for the project root. */
export interface PnpTopLevelLocator {
    name: null;
    reference: null;
}

/**
 * Dependency target in {@link PnpPackageInformation.packageDependencies}:
 * - a reference, for a package with the same name as the dependency,
 * - a `[name, reference]` tuple, for aliased dependencies (`"foo": "npm:bar@1.2.3"`),
 * - `null` when the dependency isn't available at all, typically a peer dependency not provided by the parent.
 */
export type PnpDependencyTarget = string | [name: string, reference: string] | null;

export interface PnpPackageInformation {
    /** Location of the package on disk, with a trailing slash. */
    packageLocation: string;
    packageDependencies: Map<string, PnpDependencyTarget>;
    packagePeers: Set<string>;
    /** `HARD` when the linker owns `packageLocation`, `SOFT` when it doesn't (such as workspaces, and `link:` or `portal:` dependencies). */
    linkType: "HARD" | "SOFT";
}

export interface PnpApi {
    VERSIONS: { std: number; [key: string]: number; };
    topLevel: PnpTopLevelLocator;
    getLocator(name: string, referencish: string | [name: string, reference: string]): PnpPackageLocator;
    getDependencyTreeRoots(): PnpPackageLocator[];
    getAllLocators(): PnpPackageLocator[];
    getPackageInformation(locator: PnpPackageLocator | PnpTopLevelLocator): PnpPackageInformation;
    findPackageLocator(location: string): PnpPackageLocator | null;
    /** Returns the location of `request` without applying extensions or `package.json` entry points; `null` for builtin modules unless `considerBuiltins` is `false`. Throws when the request can't be resolved. */
    resolveToUnqualified(request: string, issuer: string | null, opts?: { considerBuiltins?: boolean; }): string | null;
    resolveUnqualified(unqualified: string, opts?: { extensions?: string[]; }): string;
    resolveRequest(request: string, issuer: string | null, opts?: { considerBuiltins?: boolean; extensions?: string[]; }): string | null;
    /** Only available when `VERSIONS.resolveVirtual` is set. */
    resolveVirtual?(path: string): string | null;
}

interface ModuleWithPnp {
    /** Only set when running under PnP. */
    findPnpApi?(lookupSource: URL | string): PnpApi | null;
}

/* eslint-enable no-restricted-syntax */

export function getPnpApi(path: string): PnpApi | undefined {
    if (typeof process.versions.pnp === "undefined") {
        return;
    }

    const { findPnpApi }: ModuleWithPnp = require("module");
    if (findPnpApi) {
        return findPnpApi(`${path}/`) ?? undefined;
    }
}

export function getPnpApiPath(path: string): string | undefined {
    // eslint-disable-next-line no-restricted-syntax
    return getPnpApi(path)?.resolveRequest("pnpapi", /*issuer*/ null) ?? undefined;
}

/**
 * Yarn gives workspaces with peer dependencies a separate virtual location (under `.yarn/__virtual__`)
 * for each set of peer dependencies they get. Returns the reference of the workspace itself for those,
 * since workspaces are always used from their real location in the monorepo, as they would be through
 * `node_modules` symlinks.
 */
export function getPnpWorkspaceReference(reference: string): string {
    const match = /^virtual:[^#]*#(workspace:.*)$/.exec(reference);
    return match ? match[1] : reference;
}

/** Resolves `request` like `resolveToUnqualified`, mapping virtual workspace locations to their real location. */
export function resolvePnpRequestToUnqualified(pnpApi: PnpApi, request: string, issuer: string): string {
    // Builtins are never returned as `null`, since they aren't considered
    const resolution = pnpApi.resolveToUnqualified(request, issuer, { considerBuiltins: false })!;
    const locator = pnpApi.findPackageLocator(`${resolution}/`);
    const reference = locator && getPnpWorkspaceReference(locator.reference);
    if (!reference || reference === locator.reference) {
        return resolution;
    }
    const virtualLocation = pnpApi.getPackageInformation(locator).packageLocation;
    const realLocation = pnpApi.getPackageInformation({ name: locator.name, reference }).packageLocation;
    return `${realLocation}${`${resolution}/`.slice(virtualLocation.length)}`.replace(/[\\/]$/, "");
}
