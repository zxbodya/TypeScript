import {
    getDirectoryPath,
    resolvePath,
} from "./path.js";
import { getPnpApi } from "./pnpapi.js";

export function getPnpTypeRoots(currentDirectory: string) {
    const pnpApi = getPnpApi(currentDirectory);
    if (!pnpApi) {
        return [];
    }

    // Some TS consumers pass relative paths that aren't normalized
    currentDirectory = resolvePath(currentDirectory);

    const currentPackage = pnpApi.findPackageLocator(`${currentDirectory}/`);
    if (!currentPackage) {
        return [];
    }

    const { packageDependencies } = pnpApi.getPackageInformation(currentPackage);

    const typeRoots: string[] = [];
    for (const [name, referencish] of Array.from<any>(packageDependencies.entries())) {
        // eslint-disable-next-line no-restricted-syntax
        if (name.startsWith(`@types/`) && referencish !== null) {
            const dependencyLocator = pnpApi.getLocator(name, referencish);
            const { packageLocation } = pnpApi.getPackageInformation(dependencyLocator);

            typeRoots.push(getDirectoryPath(packageLocation));
        }
    }

    return typeRoots;
}

export function isImportablePathPnp(fromPath: string, toPath: string): boolean {
    const pnpApi = getPnpApi(fromPath);

    const fromLocator = pnpApi.findPackageLocator(fromPath);
    const toLocator = pnpApi.findPackageLocator(toPath);

    // eslint-disable-next-line no-restricted-syntax
    if (toLocator === null) {
        return false;
    }

    const fromInfo = pnpApi.getPackageInformation(fromLocator);
    const toReference = fromInfo.packageDependencies.get(toLocator.name);

    if (toReference) {
        return toReference === toLocator.reference;
    }

    // Aliased dependencies
    for (const reference of fromInfo.packageDependencies.values()) {
        if (Array.isArray(reference)) {
            if (reference[0] === toLocator.name && reference[1] === toLocator.reference) {
                return true;
            }
        }
    }

    return false;
}
