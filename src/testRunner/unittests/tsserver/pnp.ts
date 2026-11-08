import * as ts from "../../_namespaces/ts.js";
import {
    FakePnpApi,
    getPnpMonorepoFiles,
    getPnpMonorepoPackages,
    pnpPaths,
    pnpProjectRoot,
    useFakePnpApi,
} from "../helpers/pnp.js";
import {
    openFilesForSession,
    TestSession,
} from "../helpers/tsserver.js";
import { TestServerHost } from "../helpers/virtualFileSystemWithWatch.js";

describe("unittests:: tsserver:: pnp::", () => {
    let api: FakePnpApi;
    useFakePnpApi(() => api = new FakePnpApi(pnpProjectRoot, getPnpMonorepoPackages()));

    function getProject(session: TestSession, file: string) {
        return session.getProjectService().getDefaultProjectForFile(ts.server.toNormalizedPath(file), /*ensureProject*/ true)!;
    }

    it("maps project references to the virtual paths of workspaces with peer dependencies", () => {
        const libVirtualReference = "virtual:abc#workspace:packages/lib";
        const libVirtualLocation = `${pnpProjectRoot}/.yarn/__virtual__/lib-virtual-abc/2/packages/lib`;
        const packages = getPnpMonorepoPackages().map(pkg =>
            pkg.name === "app"
                ? { ...pkg, dependencies: { ...pkg.dependencies, lib: libVirtualReference } }
                : pkg
        );
        const lib = packages.find(pkg => pkg.name === "lib")!;
        packages.push({ ...lib, reference: libVirtualReference, location: libVirtualLocation });
        api.setPackages(packages);

        const host = TestServerHost.createServerHost({
            ...getPnpMonorepoFiles(),
            [`${pnpPaths.app}/tsconfig.json`]: JSON.stringify({
                compilerOptions: { module: "esnext", moduleResolution: "bundler", noEmit: true },
                references: [{ path: "../lib" }],
            }),
            [`${pnpPaths.lib}/tsconfig.json`]: JSON.stringify({ compilerOptions: { composite: true } }),
        });
        const session = new TestSession(host);
        openFilesForSession([pnpPaths.appIndex], session);

        assert.deepEqual(getProject(session, pnpPaths.appIndex).getProjectReferences()?.map(ref => ref.path), [libVirtualLocation]);
    });

    it("keeps project references that aren't part of the PnP project", () => {
        const otherProject = "/home/src/projects/other";
        const host = TestServerHost.createServerHost({
            ...getPnpMonorepoFiles(),
            [`${pnpPaths.app}/tsconfig.json`]: JSON.stringify({
                compilerOptions: { module: "esnext", moduleResolution: "bundler", noEmit: true },
                references: [{ path: otherProject }],
            }),
            [`${otherProject}/tsconfig.json`]: JSON.stringify({ compilerOptions: { composite: true } }),
            [`${otherProject}/index.ts`]: "export {};",
        });
        const session = new TestSession(host);
        openFilesForSession([pnpPaths.appIndex], session);

        assert.deepEqual(getProject(session, pnpPaths.appIndex).getProjectReferences()?.map(ref => ref.path), [otherProject]);
    });

    it("keeps project references to workspaces that aren't dependencies", () => {
        api.setPackages(
            getPnpMonorepoPackages().map(pkg => {
                if (pkg.name !== "app") return pkg;
                const { lib: _, ...dependencies } = pkg.dependencies!;
                return { ...pkg, dependencies };
            }),
        );
        const host = TestServerHost.createServerHost({
            ...getPnpMonorepoFiles(),
            [`${pnpPaths.app}/tsconfig.json`]: JSON.stringify({
                compilerOptions: { module: "esnext", moduleResolution: "bundler", noEmit: true },
                references: [{ path: "../lib" }],
            }),
            [`${pnpPaths.lib}/tsconfig.json`]: JSON.stringify({ compilerOptions: { composite: true } }),
        });
        const session = new TestSession(host);
        openFilesForSession([pnpPaths.appIndex], session);

        assert.deepEqual(getProject(session, pnpPaths.appIndex).getProjectReferences()?.map(ref => ref.path), [pnpPaths.lib]);
    });

    it("watches the PnP runtime again when host watch options change", () => {
        const host = TestServerHost.createServerHost(getPnpMonorepoFiles());
        const session = new TestSession(host);
        openFilesForSession([pnpPaths.appIndex], session);
        const getPnpWatcherCount = () => {
            let count = 0;
            host.watchUtils.pollingWatches.forEach(api.pnpApiPath, () => count++);
            host.watchUtils.fsWatches.forEach(api.pnpApiPath, () => count++);
            return count;
        };
        const setWatchFile = (watchFile: ts.server.protocol.WatchFileKind) =>
            session.executeCommandSeq<ts.server.protocol.ConfigureRequest>({
                command: ts.server.protocol.CommandTypes.Configure,
                arguments: { watchOptions: { watchFile } },
            });
        assert.strictEqual(getPnpWatcherCount(), 1);

        setWatchFile(ts.server.protocol.WatchFileKind.UseFsEvents);
        assert.strictEqual(getPnpWatcherCount(), 1);

        // Current behavior, likely a bug: the new watcher isn't stored in `pnpWatcher`,
        // so later changes close the already closed initial watcher and watchers accumulate.
        setWatchFile(ts.server.protocol.WatchFileKind.PriorityPollingInterval);
        assert.strictEqual(getPnpWatcherCount(), 2);
    });
});
