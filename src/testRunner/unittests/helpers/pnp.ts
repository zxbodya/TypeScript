import * as ts from "../../_namespaces/ts.js";

/** Either a reference, an alias (`[name, reference]`), or `null` for an unfulfilled peer dependency. */
export type PnpReferencish = string | [string, string] | null; // eslint-disable-line no-restricted-syntax

export interface PnpPackage {
    name: string;
    reference: string;
    /** Absolute path of the package directory, without trailing slash. */
    location: string;
    dependencies?: Record<string, PnpReferencish>;
}

export interface PnpLocator {
    name: string;
    reference: string;
}

export interface PnpPackageInformation {
    packageLocation: string;
    packageDependencies: Map<string, PnpReferencish>;
}

/**
 * Minimal in-memory implementation of the subset of the Yarn PnP API
 * (https://yarnpkg.com/advanced/pnpapi) that TypeScript relies on.
 */
export class FakePnpApi {
    private readonly locators = new Map<string, PnpLocator>();
    private readonly infos = new Map<PnpLocator, PnpPackageInformation>();

    constructor(
        /** Directory containing the `.pnp.cjs` file; only paths under it are part of the PnP project. */
        readonly projectRoot: string,
        packages: readonly PnpPackage[],
    ) {
        this.setPackages(packages);
    }

    get pnpApiPath(): string {
        return ts.combinePaths(this.projectRoot, ".pnp.cjs");
    }

    /** Replaces the dependency tree, as if `yarn install` had regenerated `.pnp.cjs`. */
    setPackages(packages: readonly PnpPackage[]): void {
        this.locators.clear();
        this.infos.clear();
        for (const pkg of packages) {
            // The real API hands out the same locator object for a given package, which TypeScript relies on
            const locator: PnpLocator = { name: pkg.name, reference: pkg.reference };
            this.locators.set(locatorKey(pkg.name, pkg.reference), locator);
            this.infos.set(locator, {
                packageLocation: ts.ensureTrailingDirectorySeparator(pkg.location),
                packageDependencies: new Map(Object.entries(pkg.dependencies ?? {})),
            });
        }
    }

    isInProject(path: string): boolean {
        return ts.startsWith(ts.normalizeSlashes(path), ts.ensureTrailingDirectorySeparator(this.projectRoot));
    }

    findPackageLocator(path: string): PnpLocator | null { // eslint-disable-line no-restricted-syntax
        path = ts.normalizeSlashes(path);
        let best: PnpLocator | undefined;
        let bestLength = -1;
        this.infos.forEach((info, locator) => {
            const location = info.packageLocation;
            if ((ts.startsWith(path, location) || path === location.slice(0, -1)) && location.length > bestLength) {
                best = locator;
                bestLength = location.length;
            }
        });
        return best ?? null; // eslint-disable-line no-restricted-syntax
    }

    getLocator(name: string, referencish: string | [string, string]): PnpLocator {
        return ts.isArray(referencish)
            ? { name: referencish[0], reference: referencish[1] }
            : { name, reference: referencish };
    }

    getPackageInformation(locator: PnpLocator): PnpPackageInformation {
        const info = this.infos.get(this.locators.get(locatorKey(locator.name, locator.reference))!);
        if (!info) {
            throw new Error(`Unknown locator ${locator.name}@${locator.reference}`);
        }
        return info;
    }

    resolveToUnqualified(request: string, issuer: string, _opts?: { considerBuiltins?: boolean; }): string {
        const { packageName, rest } = ts.parsePackageName(request);
        const issuerLocator = this.findPackageLocator(issuer);
        if (!issuerLocator) {
            throw new Error(`Issuer ${issuer} isn't part of the PnP project`);
        }
        const referencish = this.getPackageInformation(issuerLocator).packageDependencies.get(packageName);
        if (!referencish) {
            throw new Error(`${issuerLocator.name} tried to access ${packageName}, but it isn't declared in its dependencies`);
        }
        const { packageLocation } = this.getPackageInformation(this.getLocator(packageName, referencish));
        return ts.removeTrailingDirectorySeparator(ts.combinePaths(packageLocation, rest));
    }

    resolveRequest(request: string, issuer: string | null): string | null { // eslint-disable-line no-restricted-syntax
        if (request === "pnpapi" && issuer === null) { // eslint-disable-line no-restricted-syntax
            return this.pnpApiPath;
        }
        throw new Error(`FakePnpApi.resolveRequest: unsupported request ${request}`);
    }
}

function locatorKey(name: string, reference: string) {
    return `${name}@${reference}`;
}

interface ModuleWithPnp {
    findPnpApi?: (path: string) => unknown;
}

/**
 * Makes the running process look like it was started under Yarn PnP:
 * sets `process.versions.pnp` and installs `require("module").findPnpApi`.
 *
 * Paths inside `api.projectRoot` are mapped to `api`. Paths outside of the virtual file system
 * (such as the location of the running TypeScript itself) are also mapped to `api`,
 * as if TypeScript was installed in the PnP project.
 *
 * Returns a function restoring the original state.
 */
export function installFakePnpApi(api: FakePnpApi): () => void {
    const module: ModuleWithPnp = require("module");
    const originalFindPnpApi = module.findPnpApi;
    const hadPnpVersion = ts.hasProperty(process.versions, "pnp");
    const originalPnpVersion = (process.versions as Record<string, string | undefined>).pnp;

    (process.versions as Record<string, string | undefined>).pnp = "3";
    module.findPnpApi = path => api.isInProject(path) || !ts.startsWith(ts.normalizeSlashes(path), "/home/src/") ? api : null; // eslint-disable-line no-restricted-syntax

    return () => {
        module.findPnpApi = originalFindPnpApi;
        if (!originalFindPnpApi) delete module.findPnpApi;
        if (hadPnpVersion) (process.versions as Record<string, string | undefined>).pnp = originalPnpVersion;
        else delete (process.versions as Record<string, string | undefined>).pnp;
    };
}

/** Installs `api` for the duration of each test in the enclosing `describe`. */
export function useFakePnpApi(getApi: () => FakePnpApi): void {
    let uninstall: (() => void) | undefined;
    beforeEach(() => {
        uninstall = installFakePnpApi(getApi());
    });
    afterEach(() => {
        uninstall?.();
        uninstall = undefined;
    });
}

export const pnpProjectRoot = "/home/src/projects/project";

const cache = `${pnpProjectRoot}/.yarn/cache`;

/**
 * A Yarn PnP monorepo:
 * - `app` workspace depends on the `lib` workspace, `foo`, `exp`, `@types/env`,
 *   and `qux` through the `aliased` alias (`"aliased": "npm:qux@2.0.0"`).
 * - `lib` workspace depends on `baz`, which `app` does not depend on.
 *
 * None of the packages are reachable through `node_modules` lookups.
 */
export function getPnpMonorepoPackages(): PnpPackage[] {
    return [
        {
            name: "project",
            reference: "workspace:.",
            location: pnpProjectRoot,
            dependencies: { project: "workspace:." },
        },
        {
            name: "app",
            reference: "workspace:packages/app",
            location: `${pnpProjectRoot}/packages/app`,
            dependencies: {
                "app": "workspace:packages/app",
                "lib": "workspace:packages/lib",
                "foo": "npm:1.0.0",
                "exp": "npm:1.0.0",
                "aliased": ["qux", "npm:2.0.0"],
                "@types/env": "npm:1.0.0",
                "@types/unmet-peer": null, // eslint-disable-line no-restricted-syntax
            },
        },
        {
            name: "lib",
            reference: "workspace:packages/lib",
            location: `${pnpProjectRoot}/packages/lib`,
            dependencies: { lib: "workspace:packages/lib", baz: "npm:1.0.0" },
        },
        { name: "foo", reference: "npm:1.0.0", location: `${cache}/foo-npm-1.0.0.zip/node_modules/foo` },
        { name: "exp", reference: "npm:1.0.0", location: `${cache}/exp-npm-1.0.0.zip/node_modules/exp` },
        { name: "qux", reference: "npm:2.0.0", location: `${cache}/qux-npm-2.0.0.zip/node_modules/qux` },
        { name: "baz", reference: "npm:1.0.0", location: `${cache}/baz-npm-1.0.0.zip/node_modules/baz` },
        { name: "@types/env", reference: "npm:1.0.0", location: `${cache}/@types-env-npm-1.0.0.zip/node_modules/@types/env` },
    ];
}

export function getPnpMonorepoFiles(): ts.MapLike<string> {
    return {
        [`${pnpProjectRoot}/.pnp.cjs`]: "/* generated by yarn */",
        [`${pnpProjectRoot}/package.json`]: JSON.stringify({ name: "project", private: true, workspaces: ["packages/*"] }),
        [`${pnpProjectRoot}/packages/app/package.json`]: JSON.stringify({
            name: "app",
            dependencies: { "lib": "workspace:*", "foo": "1.0.0", "exp": "1.0.0", "aliased": "npm:qux@2.0.0", "@types/env": "1.0.0" },
        }),
        [`${pnpProjectRoot}/packages/app/tsconfig.json`]: JSON.stringify({ compilerOptions: { module: "esnext", moduleResolution: "bundler", strict: true, noEmit: true } }),
        [`${pnpProjectRoot}/packages/app/src/index.ts`]: `import { libValue } from "lib";\nimport { fooValue } from "foo";\nexport const value = libValue + fooValue;\n`,
        [`${pnpProjectRoot}/packages/app/src/util.ts`]: `export const utilValue = 1;\n`,
        [`${pnpProjectRoot}/packages/lib/package.json`]: JSON.stringify({ name: "lib", dependencies: { baz: "1.0.0" } }),
        [`${pnpProjectRoot}/packages/lib/index.ts`]: `export { bazValue } from "baz";\nexport const libValue = 1;\n`,
        [`${pnpProjectRoot}/packages/lib/thing.ts`]: `export interface LibThing { lib: true; }\n`,
        [`${pnpProjectRoot}/packages/lib/sub/index.ts`]: `export const libSub = 1;\n`,
        [`${pnpProjectRoot}/packages/lib/sub/deep.ts`]: `export const libDeep = 1;\n`,
        [`${cache}/foo-npm-1.0.0.zip/node_modules/foo/package.json`]: JSON.stringify({ name: "foo", version: "1.0.0", types: "index.d.ts" }),
        [`${cache}/foo-npm-1.0.0.zip/node_modules/foo/index.d.ts`]: `export declare const fooValue: number;\n`,
        [`${cache}/foo-npm-1.0.0.zip/node_modules/foo/sub.d.ts`]: `export declare const fooSub: number;\n`,
        [`${cache}/exp-npm-1.0.0.zip/node_modules/exp/package.json`]: JSON.stringify({
            name: "exp",
            version: "1.0.0",
            exports: { "./feature": { types: "./dist/feature.d.ts", default: "./dist/feature.js" } },
        }),
        [`${cache}/exp-npm-1.0.0.zip/node_modules/exp/dist/feature.d.ts`]: `export declare const feature: number;\n`,
        [`${cache}/qux-npm-2.0.0.zip/node_modules/qux/package.json`]: JSON.stringify({ name: "qux", version: "2.0.0", types: "index.d.ts" }),
        [`${cache}/qux-npm-2.0.0.zip/node_modules/qux/index.d.ts`]: `export declare const quxValue: number;\n`,
        [`${cache}/qux-npm-2.0.0.zip/node_modules/qux/types.d.ts`]: `export interface QuxThing { qux: true; }\n`,
        [`${cache}/baz-npm-1.0.0.zip/node_modules/baz/package.json`]: JSON.stringify({ name: "baz", version: "1.0.0", types: "index.d.ts" }),
        [`${cache}/baz-npm-1.0.0.zip/node_modules/baz/index.d.ts`]: `export declare const bazValue: number;\n`,
        [`${cache}/@types-env-npm-1.0.0.zip/node_modules/@types/env/package.json`]: JSON.stringify({ name: "@types/env", version: "1.0.0", types: "index.d.ts" }),
        [`${cache}/@types-env-npm-1.0.0.zip/node_modules/@types/env/index.d.ts`]: `export declare const env: string;\n`,
    };
}

export const pnpPaths = {
    app: `${pnpProjectRoot}/packages/app`,
    appIndex: `${pnpProjectRoot}/packages/app/src/index.ts`,
    appUtil: `${pnpProjectRoot}/packages/app/src/util.ts`,
    lib: `${pnpProjectRoot}/packages/lib`,
    libIndex: `${pnpProjectRoot}/packages/lib/index.ts`,
    libThing: `${pnpProjectRoot}/packages/lib/thing.ts`,
    libSubIndex: `${pnpProjectRoot}/packages/lib/sub/index.ts`,
    libSubDeep: `${pnpProjectRoot}/packages/lib/sub/deep.ts`,
    fooIndex: `${cache}/foo-npm-1.0.0.zip/node_modules/foo/index.d.ts`,
    fooSub: `${cache}/foo-npm-1.0.0.zip/node_modules/foo/sub.d.ts`,
    expFeature: `${cache}/exp-npm-1.0.0.zip/node_modules/exp/dist/feature.d.ts`,
    quxIndex: `${cache}/qux-npm-2.0.0.zip/node_modules/qux/index.d.ts`,
    quxTypes: `${cache}/qux-npm-2.0.0.zip/node_modules/qux/types.d.ts`,
    bazIndex: `${cache}/baz-npm-1.0.0.zip/node_modules/baz/index.d.ts`,
    typesEnvRoot: `${cache}/@types-env-npm-1.0.0.zip/node_modules/@types`,
    typesEnvIndex: `${cache}/@types-env-npm-1.0.0.zip/node_modules/@types/env/index.d.ts`,
};
