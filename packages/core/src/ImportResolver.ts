import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { Options } from './Options';
import { SourceCache } from './SourceCache';
import { Uri } from 'monaco-editor/esm/vs/editor/editor.api';
import { DummySourceCache } from './DummySourceCache';
import { UnpkgSourceResolver } from './UnpkgSourceResolver';
import { DependencyParser } from './DependencyParser';
import {
  ImportResourcePath,
  ImportResourcePathPackage,
  ImportResourcePathRelativeInPackage,
} from './ImportResourcePath';
import { SourceResolver } from './SourceResolver';
import * as path from 'path';

export class ImportResolver {
  private loadedFiles: string[];
  private dependencyParser: DependencyParser;

  constructor(
    private options: Options,
    private cache: SourceCache,
    private sourceResolver: SourceResolver,
    private versions?: { [packageName: string]: string },
  ) {
    this.loadedFiles = [];
    this.dependencyParser = new DependencyParser();
  }

  public async resolveImportsInFile(source: string, parent: string | ImportResourcePath) {
    console.log("Parsing source", source, parent)
    const imports = this.dependencyParser.parseDependencies(source, parent);
    for (const importCall of imports) {
      console.log("Import call", importCall)
      const hash = this.hashImportResourcePath(importCall);
      if (!this.loadedFiles.includes(hash)) {
        this.loadedFiles.push(hash);
        await this.resolveImport(importCall);
        // switch (importCall.kind) {
        //   case 'absolute':
        //   case 'relative':
        //     throw Error('Absolute or relative resolvements not yet supported');
        //   case 'package':
        //     await this.sourceResolver.resolveSourceFile(
        //       packageName,
        //       this.versions?.[packageName],
        //       pkg.typings.startsWith('./') ? pkg.typings.slice(2) : pkg.typings
        //     );
        // }
      }
    }
  }

  private async resolveImport(importResource: ImportResourcePath) {
    console.log("Resolving", importResource)
    switch (importResource.kind) {
      case 'package':
        const packageRelativeImport = await this.resolveImportFromPackageRoot(importResource);
        console.log("Made import relative to package:", packageRelativeImport, importResource)
        return await this.resolveImportInPackage(packageRelativeImport);
      case 'relative':
        throw Error('Not implemented yet');
      case 'relative-in-package':
        return await this.resolveImportInPackage(importResource);
    }
  }

  private async resolveImportInPackage(importResource: ImportResourcePathRelativeInPackage) {
    const { source, at } = await this.loadSourceFileContents(importResource);
    this.createModel(source, Uri.parse(this.options.fileRootPath + path.join(`node_modules/${importResource.packageName}`, at)));
    await this.resolveImportsInFile(source, {
      kind: 'relative-in-package',
      packageName: importResource.packageName,
      sourcePath: path.dirname(at),
      importPath: ''
    });
  }

  private async resolveImportFromPackageRoot(importResource: ImportResourcePathPackage): Promise<ImportResourcePathRelativeInPackage> {
    const pkgJson = await this.sourceResolver.resolvePackageJson(
      importResource.packageName,
      this.versions?.[importResource.packageName]
    );

    if (pkgJson) {
      const pkg = JSON.parse(pkgJson);
      console.log(pkg, "!!")
      if (pkg.typings || pkg.types) {
        const typings = pkg.typings || pkg.types;
        this.createModel(pkgJson, Uri.parse(`${this.options.fileRootPath}node_modules/${importResource.packageName}/package.json`));
        return {
          kind: 'relative-in-package',
          packageName: importResource.packageName,
          sourcePath: '',
          importPath: typings.startsWith('./') ? typings.slice(2) : typings
        };
      } else {
        const typingPackageName = `@types/${importResource.packageName.startsWith('@')
          ? importResource.packageName.slice(1).replace(/\//, '__')
          : importResource.packageName}`;
        const pkgJsonTypings = await this.sourceResolver.resolvePackageJson(
          typingPackageName,
          this.versions?.[typingPackageName]
        );
        if (pkgJsonTypings) {
          const pkg = JSON.parse(pkgJsonTypings);
          if (pkg.typings || pkg.types) {
            const typings = pkg.typings || pkg.types;
            this.createModel(pkgJsonTypings, Uri.parse(`${this.options.fileRootPath}node_modules/${typingPackageName}/package.json`));
            return {
              kind: 'relative-in-package',
              packageName: typingPackageName,
              sourcePath: '',
              importPath: typings.startsWith('./') ? typings.slice(2) : typings
            };
          } else {
            throw Error(`${typingPackageName} exists, but does not provide types.`)
          }
        } else {
          throw Error(`Package exists ${importResource.packageName}, but does not provide typings, `
            + `and ${typingPackageName} does not exist.`);
        }
      }
    } else {
      throw Error(`Cannot find package ${importResource.packageName}`);
    }
  }

  private async loadSourceFileContents(importResource: ImportResourcePathRelativeInPackage): Promise<{ source: string, at: string }> {
    const pkgName = importResource.packageName;
    const version = this.getVersion(importResource.packageName);

    let appends = ['.d.ts', '/index.d.ts', '.ts', '.tsx', '/index.ts', '/index.tsx'];

    if (appends.map(append => importResource.importPath.endsWith(append)).reduce((a, b) => a || b, false)) {
      const source = await this.sourceResolver.resolveSourceFile(pkgName, version,
        path.join(importResource.sourcePath, importResource.importPath));
      if (source) {
        console.log("Found source code at " + path.join(importResource.sourcePath, importResource.importPath), pkgName, source)
        return { source, at: path.join(importResource.sourcePath, importResource.importPath) };
      }
    } else {
      for (const append of appends) {
        const source = await this.sourceResolver.resolveSourceFile(pkgName, version,
          path.join(importResource.sourcePath, importResource.importPath) + append);
        if (source) {
          console.log("Found source code at " + path.join(importResource.sourcePath, importResource.importPath) + append, pkgName, source)
          return { source, at: path.join(importResource.sourcePath, importResource.importPath) + append };
        }
      }
    }

    throw Error(`Could not resolve ${importResource.packageName}/${importResource.sourcePath}${importResource.importPath}`);
  }

  /*private async findTypingsRootFile(packageName: string): ImportResourcePath {
    const pkgJson = await this.sourceResolver.resolvePackageJson(
      packageName,
      this.versions?.[packageName]
    );

    if (pkgJson) {
      const pkg = JSON.parse(pkgJson);
      if (pkg.typings) {
        return {
          kind: 'relative-in-package',
          packageName: packageName,
          sourcePath: '',
          importPath: pkg.typings.startsWith('./') ? pkg.typings.slice(2) : pkg.typings
        }
      } else {

      }
    } else {
      throw Error(`Cannot find package ${packageName}`);
    }
  }*/

  private getVersion(packageName: string) {
    return this.versions?.[packageName];
  }

  public setVersions(versions?: { [packageName: string]: string }) {
    this.versions = versions;
  }

  private createModel(source: string, uri: Uri) {
    console.log("Adding model", monaco.editor.getModels().map(model => model.uri.toString()), uri.toString())
    monaco.editor.createModel(source, 'typescript', uri);
  }

  private hashImportResourcePath(p: ImportResourcePath) {
    switch (p.kind) {
      case 'package':
        return `${p.packageName}/${p.importPath}`;
      case 'relative':
        return `.${p.sourcePath}/${p.importPath}`;
      case 'relative-in-package':
        return `${p.packageName}/${p.sourcePath}/${p.importPath}`;
    }
  }
}