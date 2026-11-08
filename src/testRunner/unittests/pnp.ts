import {
    getPnpTypeRoots,
    isImportablePathPnp,
} from "../../compiler/pnp.js";
import {
    getPnpApi,
    getPnpApiPath,
} from "../../compiler/pnpapi.js";
import * as ts from "../_namespaces/ts.js";
import {
    FakePnpApi,
    getPnpMonorepoFiles,
    getPnpMonorepoPackages,
    installFakePnpApi,
    pnpPaths,
    pnpProjectRoot,
    useFakePnpApi,
} from "./helpers/pnp.js";
import { TestServerHost } from "./helpers/virtualFileSystemWithWatch.js";

const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
};

function createHost() {
    return TestServerHost.createServerHost(getPnpMonorepoFiles(), { overrideCurrentDirectory: pnpPaths.app });
}

function createFakePnpApi() {
    return new FakePnpApi(pnpProjectRoot, getPnpMonorepoPackages());
}

function resolve(host: TestServerHost, moduleName: string, containingFile = pnpPaths.appIndex) {
    return ts.resolveModuleName(moduleName, containingFile, options, host).resolvedModule;
}

function getNodeModulesTypeRoots(directory: string) {
    const typeRoots: string[] = [];
    ts.forEachAncestorDirectory(directory, ancestor => {
        typeRoots.push(ts.combinePaths(ancestor, "node_modules/@types"));
    });
    return typeRoots;
}

function createLanguageService(host: TestServerHost, rootFiles: string[], compilerOptions: ts.CompilerOptions = options) {
    const lsHost: ts.LanguageServiceHost = {
        getCompilationSettings: () => compilerOptions,
        getScriptFileNames: () => rootFiles,
        getScriptVersion: fileName => host.readFile(fileName)!,
        getScriptSnapshot: fileName => {
            const text = host.readFile(fileName);
            return text !== undefined ? ts.ScriptSnapshot.fromString(text) : undefined;
        },
        getCurrentDirectory: () => pnpPaths.app,
        getDefaultLibFileName: options => ts.combinePaths(ts.getDirectoryPath(host.getExecutingFilePath()), ts.getDefaultLibFileName(options)),
        readFile: path => host.readFile(path),
        fileExists: path => host.fileExists(path),
        directoryExists: path => host.directoryExists(path),
        getDirectories: path => host.getDirectories(path),
        readDirectory: (path, extensions, exclude, include, depth) => host.readDirectory(path, extensions, exclude, include, depth),
        realpath: path => host.realpath(path),
        useCaseSensitiveFileNames: () => host.useCaseSensitiveFileNames,
    };
    return { lsHost, service: ts.createLanguageService(lsHost) };
}

describe("unittests:: pnp:: pnpapi", () => {
    it("is disabled when not running under PnP", () => {
        const module: { findPnpApi?: unknown; } = require("module");
        const original = module.findPnpApi;
        module.findPnpApi = () => createFakePnpApi();
        try {
            assert.isUndefined(process.versions.pnp);
            assert.isUndefined(getPnpApi(pnpPaths.app));
            assert.isUndefined(getPnpApiPath(pnpPaths.app));
        }
        finally {
            module.findPnpApi = original;
            if (!original) delete module.findPnpApi;
        }
    });

    it("is disabled when the runtime doesn't provide findPnpApi", () => {
        const uninstall = installFakePnpApi(createFakePnpApi());
        const module: { findPnpApi?: unknown; } = require("module");
        delete module.findPnpApi;
        try {
            assert.isDefined(process.versions.pnp);
            assert.isUndefined(getPnpApi(pnpPaths.app));
            assert.isUndefined(getPnpApiPath(pnpPaths.app));
        }
        finally {
            uninstall();
        }
    });

    it("finds the PnP API and the path of the PnP runtime", () => {
        const api = createFakePnpApi();
        const uninstall = installFakePnpApi(api);
        try {
            assert.strictEqual(getPnpApi(pnpPaths.app), api);
            assert.strictEqual(getPnpApiPath(pnpPaths.app), `${pnpProjectRoot}/.pnp.cjs`);
            assert.isUndefined(getPnpApi("/home/src/projects/other"));
        }
        finally {
            uninstall();
        }
        assert.isUndefined(process.versions.pnp);
    });
});

describe("unittests:: pnp:: getPnpTypeRoots", () => {
    useFakePnpApi(createFakePnpApi);

    it("returns the location of @types dependencies of the current package", () => {
        assert.deepEqual(getPnpTypeRoots(pnpPaths.app), [pnpPaths.typesEnvRoot]);
        assert.deepEqual(getPnpTypeRoots(`${pnpPaths.app}/src`), [pnpPaths.typesEnvRoot]);
    });

    it("returns nothing for packages without @types dependencies", () => {
        assert.deepEqual(getPnpTypeRoots(pnpPaths.lib), []);
    });

    it("returns nothing outside of the PnP project", () => {
        assert.deepEqual(getPnpTypeRoots("/home/src/projects/other"), []);
    });

    it("returns nothing for paths of the PnP project that aren't in any package", () => {
        const uninstall = installFakePnpApi(new FakePnpApi(pnpProjectRoot, getPnpMonorepoPackages().filter(pkg => pkg.name !== "project")));
        try {
            assert.deepEqual(getPnpTypeRoots(`${pnpProjectRoot}/scripts`), []);
        }
        finally {
            uninstall();
        }
    });

    it("is used alongside node_modules/@types to compute the default type roots", () => {
        const expected = [...getNodeModulesTypeRoots(pnpPaths.app), pnpPaths.typesEnvRoot];
        assert.deepEqual(ts.getEffectiveTypeRoots({}, { getCurrentDirectory: () => pnpPaths.app }), expected);
        assert.deepEqual(ts.getEffectiveTypeRoots({ configFilePath: `${pnpPaths.app}/tsconfig.json` }, {}), expected);
    });
});

describe("unittests:: pnp:: isImportablePathPnp", () => {
    useFakePnpApi(createFakePnpApi);

    it("allows importing from dependencies", () => {
        assert.isTrue(isImportablePathPnp(pnpPaths.appIndex, pnpPaths.libThing));
        assert.isTrue(isImportablePathPnp(pnpPaths.appIndex, pnpPaths.fooIndex));
    });

    it("allows importing from aliased dependencies", () => {
        assert.isTrue(isImportablePathPnp(pnpPaths.appIndex, pnpPaths.quxTypes));
    });

    it("allows importing from the same package", () => {
        assert.isTrue(isImportablePathPnp(pnpPaths.appIndex, pnpPaths.appUtil));
    });

    it("disallows importing from packages that aren't dependencies", () => {
        assert.isFalse(isImportablePathPnp(pnpPaths.appIndex, pnpPaths.bazIndex));
        assert.isTrue(isImportablePathPnp(pnpPaths.libIndex, pnpPaths.bazIndex));
    });

    it("disallows importing from paths outside of the PnP project", () => {
        assert.isFalse(isImportablePathPnp(pnpPaths.appIndex, "/home/src/projects/other/index.ts"));
    });

    it("disallows importing from files that aren't part of any package", () => {
        // The PnP API of the running TypeScript also covers paths outside of the project, which have no package
        assert.isFalse(isImportablePathPnp("/outside/index.ts", pnpPaths.fooIndex));
    });
});

describe("unittests:: pnp:: module resolution", () => {
    useFakePnpApi(createFakePnpApi);

    it("resolves workspace dependencies", () => {
        assert.strictEqual(resolve(createHost(), "lib")?.resolvedFileName, pnpPaths.libIndex);
        assert.strictEqual(resolve(createHost(), "lib/thing")?.resolvedFileName, pnpPaths.libThing);
    });

    it("resolves package dependencies and their subpaths", () => {
        const host = createHost();
        const foo = resolve(host, "foo");
        assert.strictEqual(foo?.resolvedFileName, pnpPaths.fooIndex);
        assert.isTrue(foo?.isExternalLibraryImport);
        assert.strictEqual(foo?.packageId?.name, "foo");
        assert.strictEqual(resolve(host, "foo/sub")?.resolvedFileName, pnpPaths.fooSub);
    });

    it("resolves package exports", () => {
        const host = createHost();
        assert.strictEqual(resolve(host, "exp/feature")?.resolvedFileName, pnpPaths.expFeature);
        assert.isUndefined(resolve(host, "exp/dist/feature"));
    });

    it("resolves aliased dependencies", () => {
        const host = createHost();
        assert.strictEqual(resolve(host, "aliased")?.resolvedFileName, pnpPaths.quxIndex);
        assert.strictEqual(resolve(host, "aliased/types")?.resolvedFileName, pnpPaths.quxTypes);
        assert.isUndefined(resolve(host, "qux"));
    });

    it("resolves @types dependencies", () => {
        assert.strictEqual(resolve(createHost(), "env")?.resolvedFileName, pnpPaths.typesEnvIndex);
    });

    it("does not resolve packages that aren't dependencies of the issuer", () => {
        const host = createHost();
        assert.isUndefined(resolve(host, "baz"));
        assert.strictEqual(resolve(host, "baz", pnpPaths.libIndex)?.resolvedFileName, pnpPaths.bazIndex);
    });

    it("does not fall back to node_modules lookups", () => {
        const host = createHost();
        host.ensureFileOrFolder({ path: `${pnpProjectRoot}/node_modules/baz/index.d.ts`, content: "export {};" });
        assert.isUndefined(resolve(host, "baz"));
    });

    it("resolves type reference directives using PnP type roots", () => {
        const resolution = ts.resolveTypeReferenceDirective("env", pnpPaths.appIndex, {}, createHost());
        assert.strictEqual(resolution.resolvedTypeReferenceDirective?.resolvedFileName, pnpPaths.typesEnvIndex);
    });

    it("resolves package.json of dependencies", () => {
        const host = createHost();
        assert.strictEqual(ts.resolvePackageNameToPackageJson("foo", pnpPaths.app, options, host, /*cache*/ undefined)?.packageDirectory, ts.getDirectoryPath(pnpPaths.fooIndex));
        assert.isUndefined(ts.resolvePackageNameToPackageJson("baz", pnpPaths.app, options, host, /*cache*/ undefined));
    });

    it("includes PnP @types packages in programs by default", () => {
        const host = createHost();
        const program = ts.createProgram({
            rootNames: [pnpPaths.appIndex],
            options,
            host: ts.createCompilerHostWorker(options, /*setParentNodes*/ undefined, host),
        });
        assert.isDefined(program.getSourceFile(pnpPaths.typesEnvIndex));
        assert.isDefined(program.getSourceFile(pnpPaths.libIndex));
        assert.isDefined(program.getSourceFile(pnpPaths.bazIndex));
        assert.deepEqual(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n")), []);
    });
});

describe("unittests:: pnp:: module resolution cache", () => {
    useFakePnpApi(createFakePnpApi);

    function createResolver() {
        const host = createHost();
        const traces: string[] = [];
        const resolutionHost: ts.ModuleResolutionHost = {
            fileExists: path => host.fileExists(path),
            readFile: path => host.readFile(path),
            directoryExists: path => host.directoryExists(path),
            realpath: path => host.realpath(path),
            getCurrentDirectory: () => pnpPaths.app,
            useCaseSensitiveFileNames: host.useCaseSensitiveFileNames,
            trace: s => traces.push(s),
        };
        const resolutionOptions: ts.CompilerOptions = { ...options, traceResolution: true };
        const cache = ts.createModuleResolutionCache(pnpPaths.app, ts.createGetCanonicalFileName(host.useCaseSensitiveFileNames), resolutionOptions);
        return {
            resolve(moduleName: string, containingFile: string) {
                traces.length = 0;
                const resolved = ts.resolveModuleName(moduleName, containingFile, resolutionOptions, resolutionHost, cache, /*redirectedReference*/ undefined, ts.ModuleKind.ESNext).resolvedModule?.resolvedFileName;
                return { resolved, fromCache: traces.some(t => t.includes("was found in cache from location")) };
            },
        };
    }

    it("reuses resolutions from ancestor directories within the same package", () => {
        const { resolve } = createResolver();
        assert.deepEqual(resolve("foo", `${pnpPaths.app}/src/nested/file.ts`), { resolved: pnpPaths.fooIndex, fromCache: false });
        assert.deepEqual(resolve("foo", pnpPaths.appIndex), { resolved: pnpPaths.fooIndex, fromCache: true });
    });

    it("does not reuse resolutions in sibling packages", () => {
        const { resolve } = createResolver();
        assert.deepEqual(resolve("foo", pnpPaths.appIndex), { resolved: pnpPaths.fooIndex, fromCache: false });
        assert.deepEqual(resolve("foo", pnpPaths.libIndex), { resolved: undefined, fromCache: false });
    });

    it("reuses resolutions in ancestor packages that don't have the dependency", () => {
        const { resolve } = createResolver();
        assert.deepEqual(resolve("foo", pnpPaths.appIndex), { resolved: pnpPaths.fooIndex, fromCache: false });
        // Current behavior, likely a bug: the cache shares a resolution with ancestor directories up to the common
        // prefix with the resolved file, which only holds for node_modules lookups. The root workspace doesn't
        // depend on `foo`, and resolves it only because `app` did first.
        assert.deepEqual(resolve("foo", `${pnpProjectRoot}/index.ts`), { resolved: pnpPaths.fooIndex, fromCache: true });
    });
});

describe("unittests:: pnp:: module resolution without PnP", () => {
    it("does not resolve PnP dependencies", () => {
        assert.isUndefined(resolve(createHost(), "foo"));
        assert.deepEqual(ts.getEffectiveTypeRoots({}, { getCurrentDirectory: () => pnpPaths.app }), getNodeModulesTypeRoots(pnpPaths.app));
    });
});

describe("unittests:: pnp:: module specifiers", () => {
    useFakePnpApi(createFakePnpApi);

    function getModuleSpecifiers(importedFile: string, importingFile = pnpPaths.appIndex) {
        const host = createHost();
        const { lsHost, service } = createLanguageService(host, [pnpPaths.appIndex, pnpPaths.appUtil, pnpPaths.libThing, pnpPaths.libSubIndex, pnpPaths.libSubDeep, pnpPaths.quxTypes, pnpPaths.typesEnvIndex]);
        const program = service.getProgram()!;
        const checker = program.getTypeChecker();
        const importing = program.getSourceFile(importingFile)!;
        const imported = program.getSourceFile(importedFile)!;
        assert.isDefined(imported, `${importedFile} should be part of the program`);
        return ts.moduleSpecifiers.getModuleSpecifiers(
            checker.getMergedSymbol(imported.symbol),
            checker,
            program.getCompilerOptions(),
            importing,
            ts.createModuleSpecifierResolutionHost(program, lsHost),
            {},
        );
    }

    it("uses the package name for workspace dependencies", () => {
        assert.deepEqual(getModuleSpecifiers(pnpPaths.libIndex), ["lib"]);
        assert.deepEqual(getModuleSpecifiers(pnpPaths.libThing), ["lib/thing"]);
    });

    it("uses the package name for files in subdirectories of dependencies", () => {
        assert.deepEqual(getModuleSpecifiers(pnpPaths.libSubDeep), ["lib/sub/deep"]);
        assert.deepEqual(getModuleSpecifiers(pnpPaths.libSubIndex), ["lib/sub"]);
    });

    it("uses the package name for package dependencies", () => {
        assert.deepEqual(getModuleSpecifiers(pnpPaths.fooIndex), ["foo"]);
    });

    it("uses the alias for aliased dependencies", () => {
        assert.deepEqual(getModuleSpecifiers(pnpPaths.quxTypes), ["aliased/types"]);
    });

    it("uses the package name for @types dependencies", () => {
        assert.deepEqual(getModuleSpecifiers(pnpPaths.typesEnvIndex), ["env"]);
    });

    it("uses relative paths within the same package", () => {
        assert.deepEqual(getModuleSpecifiers(pnpPaths.appUtil), ["./util"]);
    });

    it("uses absolute paths for workspaces that aren't dependencies", () => {
        // Current behavior, likely a bug: with no dependency to take the package name from,
        // `topLevelPackageNameIndex` is undefined and the whole path ends up being used as the specifier.
        assert.deepEqual(getModuleSpecifiers(pnpPaths.appUtil, pnpPaths.libIndex), [ts.removeFileExtension(pnpPaths.appUtil)]);
    });
});

describe("unittests:: pnp:: language service", () => {
    useFakePnpApi(createFakePnpApi);

    function getCompletionNames(content: string, preferences?: ts.UserPreferences) {
        const host = createHost();
        const consumer = `${pnpPaths.app}/src/consumer.ts`;
        host.writeFile(consumer, content);
        const { service } = createLanguageService(host, [pnpPaths.appIndex, consumer]);
        const completions = service.getCompletionsAtPosition(consumer, content.length - (content.endsWith(`";`) ? 2 : 0), preferences, ts.testFormatSettings);
        return completions?.entries ?? [];
    }

    it("completes subpaths of dependencies", () => {
        const names = getCompletionNames(`import {} from "foo/";`).map(e => e.name);
        assert.includeMembers(names, ["index", "sub"]);
    });

    it("completes exports of dependencies", () => {
        const names = getCompletionNames(`import {} from "exp/";`).map(e => e.name);
        assert.deepEqual(names, ["feature"]);
    });

    it("does not complete subpaths of packages that aren't dependencies", () => {
        assert.deepEqual(getCompletionNames(`import {} from "baz/";`), []);
    });

    it("completes @types dependencies", () => {
        const names = getCompletionNames(`import {} from "";`).map(e => e.name);
        assert.include(names, "env");
    });

    it("only offers auto-imports from dependencies", () => {
        const entries = getCompletionNames(`Value`, { includeCompletionsForModuleExports: true });
        const sources = (name: string) => entries.filter(e => e.name === name).map(e => e.source);
        assert.deepEqual(sources("fooValue"), ["foo"]);
        assert.deepEqual(sources("libValue"), ["lib"]);
        assert.notInclude(sources("bazValue"), "baz");
    });
});

describe("unittests:: pnp:: auto-import filtering", () => {
    let api: FakePnpApi;
    useFakePnpApi(() => api = createFakePnpApi());

    function createFilter(extraFiles: ts.MapLike<string> = {}) {
        const host = createHost();
        for (const [path, content] of Object.entries(extraFiles)) host.writeFile(path, content);
        const { lsHost, service } = createLanguageService(host, [pnpPaths.appIndex, ...Object.keys(extraFiles)]);
        const program = service.getProgram()!;
        const fromFile = program.getSourceFile(pnpPaths.appIndex)!;
        const moduleSpecifierResolutionHost = ts.createModuleSpecifierResolutionHost(program, lsHost);
        const packageJsonFilter = ts.createPackageJsonImportFilter(fromFile, {}, lsHost);
        return {
            getSourceFileInfo: (fileName: string) => packageJsonFilter.getSourceFileInfo(program.getSourceFile(fileName)!, moduleSpecifierResolutionHost),
            isImportable: (fileName: string) => {
                const toFile = program.getSourceFile(fileName)!;
                return ts.isImportable(program, fromFile, toFile, toFile.symbol, {}, packageJsonFilter, moduleSpecifierResolutionHost, /*moduleSpecifierCache*/ undefined);
            },
        };
    }

    it("allows dependencies listed in package.json", () => {
        const { getSourceFileInfo, isImportable } = createFilter();
        assert.deepEqual(getSourceFileInfo(pnpPaths.libIndex), { importable: true, packageName: "lib" });
        assert.deepEqual(getSourceFileInfo(pnpPaths.fooIndex), { importable: true, packageName: "foo" });
        assert.isTrue(isImportable(pnpPaths.libIndex));
        assert.isTrue(isImportable(pnpPaths.fooIndex));
    });

    it("rejects packages that aren't dependencies", () => {
        const { getSourceFileInfo, isImportable } = createFilter();
        assert.deepEqual(getSourceFileInfo(pnpPaths.bazIndex), { importable: false, packageName: "baz" });
        assert.isFalse(isImportable(pnpPaths.bazIndex));
    });

    it("rejects files of the PnP project that aren't in any package", () => {
        api.setPackages(getPnpMonorepoPackages().filter(pkg => pkg.name !== "project"));
        const tool = `${pnpProjectRoot}/scripts/tool.ts`;
        const { getSourceFileInfo, isImportable } = createFilter({ [tool]: "export const tool = 1;\n" });
        assert.deepEqual(getSourceFileInfo(tool), { importable: true, packageName: undefined });
        assert.isFalse(isImportable(tool));
    });
});
