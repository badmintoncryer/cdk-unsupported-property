import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';

export interface ModuleRef {
  /** Directory basename, e.g. `aws-s3` or `aws-route53resolver-alpha` */
  name: string;
  /** Absolute path to the module directory */
  dir: string;
  isAlpha: boolean;
}

export interface DiscoveredModules {
  stable: ModuleRef[];
  alpha: ModuleRef[];
}

/** Strips `aws-` prefix and `-alpha` suffix: `aws-s3` / `aws-s3-alpha` -> `s3`. */
export const serviceName = (moduleName: string): string =>
  moduleName.replace(/^aws-/, '').replace(/-alpha$/, '');

/** Extracts the module segment (e.g. `aws-s3`) from any file path inside a module. */
export const moduleOfPath = (filePath: string): string | undefined => {
  const parts = filePath.split(path.sep);
  for (let i = parts.length - 2; i >= 0; i--) { // -2: skip the file name itself
    if (parts[i].startsWith('aws-') && parts[i] !== 'aws-cdk-lib') {
      return parts[i];
    }
  }
  return undefined;
};

/** Lists `aws-*` modules in aws-cdk-lib and `aws-*-alpha` modules in @aws-cdk. */
export const discoverModules = (packagesDir: string): DiscoveredModules => {
  const cdkLibDir = path.join(packagesDir, 'aws-cdk-lib');
  const alphaRoot = path.join(packagesDir, '@aws-cdk');

  const listDirs = (root: string, filter: (name: string) => boolean): ModuleRef[] => {
    if (!fs.existsSync(root)) {
      return [];
    }
    return fs.readdirSync(root)
      .filter(name => filter(name) && fs.statSync(path.join(root, name)).isDirectory())
      .map(name => ({
        name,
        dir: path.join(root, name),
        isAlpha: name.endsWith('-alpha'),
      }));
  };

  return {
    stable: listDirs(cdkLibDir, name => name.startsWith('aws-')),
    alpha: listDirs(alphaRoot, name => /^aws-.*-alpha$/.test(name)),
  };
};

/** All TypeScript sources under a module's lib/, excluding declarations. */
export const listLibFiles = async (moduleDir: string): Promise<string[]> => {
  const files = await glob(path.join(moduleDir, 'lib', '**', '*.ts'), {
    ignore: [path.join(moduleDir, 'lib', '**', '*.d.ts')],
  });
  return files.sort();
};

export const isGeneratedFile = (filePath: string): boolean =>
  /\.generated\.(d\.)?ts$/.test(filePath);
