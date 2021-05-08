import type { CompileOptions } from '../../@types/compiler';
import type { AstroConfig, ValidExtensionPlugins } from '../../@types/astro';
import type { Ast, Script, Style, TemplateNode } from 'astro-parser';
import type { TransformResult } from '../../@types/astro';

import eslexer from 'es-module-lexer';
import esbuild from 'esbuild';
import path from 'path';
import { walk } from 'estree-walker';
import _babelGenerator from '@babel/generator';
import babelParser from '@babel/parser';
import { codeFrameColumns } from '@babel/code-frame';
import * as babelTraverse from '@babel/traverse';
import { ImportDeclaration, ExportNamedDeclaration, VariableDeclarator, Identifier } from '@babel/types';
import { warn } from '../../logger.js';
import { fetchContent } from './content.js';
import { isFetchContent } from './utils.js';
import { yellow } from 'kleur/colors';

const traverse: typeof babelTraverse.default = (babelTraverse.default as any).default;
const babelGenerator: typeof _babelGenerator =
  // @ts-ignore
  _babelGenerator.default;
const { transformSync } = esbuild;

interface Attribute {
  start: number;
  end: number;
  type: 'Attribute';
  name: string;
  value: TemplateNode[] | boolean;
}

interface CodeGenOptions {
  compileOptions: CompileOptions;
  filename: string;
  fileID: string;
}

/** Format Astro internal import URL */
function internalImport(internalPath: string) {
  return `/_astro_internal/${internalPath}`;
}

/** Retrieve attributes from TemplateNode */
function getAttributes(attrs: Attribute[]): Record<string, string> {
  let result: Record<string, string> = {};
  for (const attr of attrs) {
    if (attr.value === true) {
      result[attr.name] = JSON.stringify(attr.value);
      continue;
    }
    if (attr.value === false || attr.value === undefined) {
      // note: attr.value shouldn’t be `undefined`, but a bad transform would cause a compile error here, so prevent that
      continue;
    }
    if (attr.value.length > 1) {
      result[attr.name] =
        '(' +
        attr.value
          .map((v: TemplateNode) => {
            if (v.content) {
              return v.content;
            } else {
              return JSON.stringify(getTextFromAttribute(v));
            }
          })
          .join('+') +
        ')';
      continue;
    }
    const val = attr.value[0];
    if (!val) {
      result[attr.name] = '(' + val + ')';
      continue;
    }
    switch (val.type) {
      case 'MustacheTag': {
        // FIXME: this won't work when JSX element can appear in attributes (rare but possible).
        result[attr.name] = '(' + val.expression.codeChunks[0] + ')';
        continue;
      }
      case 'Text':
        result[attr.name] = JSON.stringify(getTextFromAttribute(val));
        continue;
      default:
        throw new Error(`UNKNOWN: ${val.type}`);
    }
  }
  return result;
}

/** Get value from a TemplateNode Attribute (text attributes only!) */
function getTextFromAttribute(attr: any): string {
  switch (attr.type) {
    case 'Text': {
      if (attr.raw !== undefined) {
        return attr.raw;
      }
      if (attr.data !== undefined) {
        return attr.data;
      }
      break;
    }
    case 'MustacheTag': {
      // FIXME: this won't work when JSX element can appear in attributes (rare but possible).
      return attr.expression.codeChunks[0];
    }
  }
  throw new Error(`Unknown attribute type ${attr.type}`);
}

/** Convert TemplateNode attributes to string */
function generateAttributes(attrs: Record<string, string>): string {
  let result = '{';
  for (const [key, val] of Object.entries(attrs)) {
    result += JSON.stringify(key) + ':' + val + ',';
  }
  return result + '}';
}

interface ComponentInfo {
  type: string;
  url: string;
  plugin: string | undefined;
}

const defaultExtensions: Readonly<Record<string, ValidExtensionPlugins>> = {
  '.astro': 'astro',
  '.jsx': 'react',
  '.tsx': 'react',
  '.vue': 'vue',
  '.svelte': 'svelte',
};

type DynamicImportMap = Map<'vue' | 'react' | 'react-dom' | 'preact' | 'svelte', string>;

interface GetComponentWrapperOptions {
  filename: string;
  astroConfig: AstroConfig;
  dynamicImports: DynamicImportMap;
}

/** Generate Astro-friendly component import */
function getComponentWrapper(_name: string, { type, plugin, url }: ComponentInfo, opts: GetComponentWrapperOptions) {
  const { astroConfig, dynamicImports, filename } = opts;
  const { astroRoot } = astroConfig;
  const [name, kind] = _name.split(':');
  const currFileUrl = new URL(`file://${filename}`);

  if (!plugin) {
    throw new Error(`No supported plugin found for ${type ? `extension ${type}` : `${url} (try adding an extension)`}`);
  }

  const getComponentUrl = (ext = '.js') => {
    const outUrl = new URL(url, currFileUrl);
    return '/_astro/' + path.posix.relative(astroRoot.pathname, outUrl.pathname).replace(/\.[^.]+$/, ext);
  };

  switch (plugin) {
    case 'astro': {
      if (kind) {
        throw new Error(`Astro does not support :${kind}`);
      }
      return {
        wrapper: name,
        wrapperImport: ``,
      };
    }
    case 'preact': {
      if (['load', 'idle', 'visible'].includes(kind)) {
        return {
          wrapper: `__preact_${kind}(${name}, ${JSON.stringify({
            componentUrl: getComponentUrl(),
            componentExport: 'default',
            frameworkUrls: {
              preact: dynamicImports.get('preact'),
            },
          })})`,
          wrapperImport: `import {__preact_${kind}} from '${internalImport('render/preact.js')}';`,
        };
      }

      return {
        wrapper: `__preact_static(${name})`,
        wrapperImport: `import {__preact_static} from '${internalImport('render/preact.js')}';`,
      };
    }
    case 'react': {
      if (['load', 'idle', 'visible'].includes(kind)) {
        return {
          wrapper: `__react_${kind}(${name}, ${JSON.stringify({
            componentUrl: getComponentUrl(),
            componentExport: 'default',
            frameworkUrls: {
              react: dynamicImports.get('react'),
              'react-dom': dynamicImports.get('react-dom'),
            },
          })})`,
          wrapperImport: `import {__react_${kind}} from '${internalImport('render/react.js')}';`,
        };
      }

      return {
        wrapper: `__react_static(${name})`,
        wrapperImport: `import {__react_static} from '${internalImport('render/react.js')}';`,
      };
    }
    case 'svelte': {
      if (['load', 'idle', 'visible'].includes(kind)) {
        return {
          wrapper: `__svelte_${kind}(${name}, ${JSON.stringify({
            componentUrl: getComponentUrl('.svelte.js'),
            componentExport: 'default',
            frameworkUrls: {
              'svelte-runtime': internalImport('runtime/svelte.js'),
            },
          })})`,
          wrapperImport: `import {__svelte_${kind}} from '${internalImport('render/svelte.js')}';`,
        };
      }

      return {
        wrapper: `__svelte_static(${name})`,
        wrapperImport: `import {__svelte_static} from '${internalImport('render/svelte.js')}';`,
      };
    }
    case 'vue': {
      if (['load', 'idle', 'visible'].includes(kind)) {
        return {
          wrapper: `__vue_${kind}(${name}, ${JSON.stringify({
            componentUrl: getComponentUrl('.vue.js'),
            componentExport: 'default',
            frameworkUrls: {
              vue: dynamicImports.get('vue'),
            },
          })})`,
          wrapperImport: `import {__vue_${kind}} from '${internalImport('render/vue.js')}';`,
        };
      }

      return {
        wrapper: `__vue_static(${name})`,
        wrapperImport: `import {__vue_static} from '${internalImport('render/vue.js')}';`,
      };
    }
    default: {
      throw new Error(`Unknown component type`);
    }
  }
}

/** Evaluate expression (safely) */
function compileExpressionSafe(raw: string): string {
  let { code } = transformSync(raw, {
    loader: 'tsx',
    jsxFactory: 'h',
    jsxFragment: 'Fragment',
    charset: 'utf8',
  });
  return code;
}

/** Build dependency map of dynamic component runtime frameworks */
async function acquireDynamicComponentImports(plugins: Set<ValidExtensionPlugins>, resolvePackageUrl: (s: string) => Promise<string>): Promise<DynamicImportMap> {
  const importMap: DynamicImportMap = new Map();
  for (let plugin of plugins) {
    switch (plugin) {
      case 'vue': {
        importMap.set('vue', await resolvePackageUrl('vue'));
        break;
      }
      case 'react': {
        importMap.set('react', await resolvePackageUrl('react'));
        importMap.set('react-dom', await resolvePackageUrl('react-dom'));
        break;
      }
      case 'preact': {
        importMap.set('preact', await resolvePackageUrl('preact'));
        break;
      }
      case 'svelte': {
        importMap.set('svelte', await resolvePackageUrl('svelte'));
        break;
      }
    }
  }
  return importMap;
}

type Components = Record<string, { type: string; url: string; plugin: string | undefined }>;

interface CompileResult {
  script: string;
  componentPlugins: Set<ValidExtensionPlugins>;
  createCollection?: string;
}

interface CodegenState {
  filename: string;
  components: Components;
  css: string[];
  markers: {
    insideMarkdown: boolean|string;
  };
  importExportStatements: Set<string>;
  dynamicImports: DynamicImportMap;
}

/** Compile/prepare Astro frontmatter scripts */
function compileModule(module: Script, state: CodegenState, compileOptions: CompileOptions): CompileResult {
  const { extensions = defaultExtensions } = compileOptions;

  const componentImports: ImportDeclaration[] = [];
  const componentProps: VariableDeclarator[] = [];
  const componentExports: ExportNamedDeclaration[] = [];

  const contentImports = new Map<string, { spec: string; declarator: string }>();

  let script = '';
  let propsStatement = '';
  let contentCode = ''; // code for handling Astro.fetchContent(), if any;
  let createCollection = ''; // function for executing collection
  const componentPlugins = new Set<ValidExtensionPlugins>();

  if (module) {
    const parseOptions: babelParser.ParserOptions = {
      sourceType: 'module',
      plugins: ['jsx', 'typescript', 'topLevelAwait'],
    };
    let parseResult;
    try {
      parseResult = babelParser.parse(module.content, parseOptions);
    } catch (err) {
      const location = { start: err.loc };
      const frame = codeFrameColumns(module.content, location);
      err.frame = frame;
      err.filename = state.filename;
      err.start = err.loc;
      throw err;
    }
    const program = parseResult.program;

    const { body } = program;
    let i = body.length;
    while (--i >= 0) {
      const node = body[i];
      switch (node.type) {
        case 'ExportNamedDeclaration': {
          if (!node.declaration) break;
          // const replacement = extract_exports(node);

          if (node.declaration.type === 'VariableDeclaration') {
            // case 1: prop (export let title)

            const declaration = node.declaration.declarations[0];
            if ((declaration.id as Identifier).name === '__layout' || (declaration.id as Identifier).name === '__content') {
              componentExports.push(node);
            } else {
              componentProps.push(declaration);
            }
            body.splice(i, 1);
          } else if (node.declaration.type === 'FunctionDeclaration') {
            // case 2: createCollection (export async function)
            if (!node.declaration.id || node.declaration.id.name !== 'createCollection') break;
            createCollection = module.content.substring(node.declaration.start || 0, node.declaration.end || 0);

            // remove node
            body.splice(i, 1);
          }
          break;
        }
        case 'FunctionDeclaration': {
          break;
        }
        case 'ImportDeclaration': {
          componentImports.push(node);
          body.splice(i, 1); // remove node
          break;
        }
        case 'VariableDeclaration': {
          for (const declaration of node.declarations) {
            // only select Astro.fetchContent() calls here. this utility filters those out for us.
            if (!isFetchContent(declaration)) continue;

            // remove node
            body.splice(i, 1);

            // a bit of munging
            let { id, init } = declaration;
            if (!id || !init || id.type !== 'Identifier') continue;
            if (init.type === 'AwaitExpression') {
              init = init.argument;
              const shortname = path.relative(compileOptions.astroConfig.projectRoot.pathname, state.filename);
              warn(compileOptions.logging, shortname, yellow('awaiting Astro.fetchContent() not necessary'));
            }
            if (init.type !== 'CallExpression') continue;

            // gather data
            const namespace = id.name;

            if ((init as any).arguments[0].type !== 'StringLiteral') {
              throw new Error(`[Astro.fetchContent] Only string literals allowed, ex: \`Astro.fetchContent('./post/*.md')\`\n  ${state.filename}`);
            }
            const spec = (init as any).arguments[0].value;
            if (typeof spec === 'string') contentImports.set(namespace, { spec, declarator: node.kind });
          }
          break;
        }
      }
    }

    for (const componentImport of componentImports) {
      const importUrl = componentImport.source.value;
      let componentType = path.posix.extname(importUrl);
      if (!componentType) {
        if (path.posix.dirname(importUrl) === 'astro') {
          componentType = '.astro';
        }
      }
      const specifier = componentImport.specifiers[0];
      if (!specifier) continue; // this is unused
      
      // set componentName to default import if used (user), or use filename if no default import (mostly internal use)
      const componentName = ['ImportDefaultSpecifier', 'ImportSpecifier'].includes(specifier.type) ? specifier.local.name : path.posix.basename(importUrl, componentType);
      const plugin = extensions[componentType] || defaultExtensions[componentType];
      state.components[componentName] = {
        type: componentType,
        plugin,
        url: importUrl,
      };
      if (plugin) {
        componentPlugins.add(plugin);
      }
      const { start, end } = componentImport;
      state.importExportStatements.add(module.content.slice(start || undefined, end || undefined));
    }
    for (const componentImport of componentExports) {
      const { start, end } = componentImport;
      state.importExportStatements.add(module.content.slice(start || undefined, end || undefined));
    }

    if (componentProps.length > 0) {
      propsStatement = 'let {';
      for (const componentExport of componentProps) {
        propsStatement += `${(componentExport.id as Identifier).name}`;
        const { init } = componentExport;
        if (init) {
          propsStatement += `= ${babelGenerator(init).code}`;
        }
        propsStatement += `,`;
      }
      propsStatement += `} = props;\n`;
    }

    // handle createCollection, if any
    if (createCollection) {
      // TODO: improve this? while transforming in-place isn’t great, this happens at most once per-route
      const ast = babelParser.parse(createCollection, {
        sourceType: 'module',
      });
      traverse(ast, {
        enter({ node }) {
          switch (node.type) {
            case 'VariableDeclaration': {
              for (const declaration of node.declarations) {
                // only select Astro.fetchContent() calls here. this utility filters those out for us.
                if (!isFetchContent(declaration)) continue;

                // a bit of munging
                let { id, init } = declaration;
                if (!id || !init || id.type !== 'Identifier') continue;
                if (init.type === 'AwaitExpression') {
                  init = init.argument;
                  const shortname = path.relative(compileOptions.astroConfig.projectRoot.pathname, state.filename);
                  warn(compileOptions.logging, shortname, yellow('awaiting Astro.fetchContent() not necessary'));
                }
                if (init.type !== 'CallExpression') continue;

                // gather data
                const namespace = id.name;

                if ((init as any).arguments[0].type !== 'StringLiteral') {
                  throw new Error(`[Astro.fetchContent] Only string literals allowed, ex: \`Astro.fetchContent('./post/*.md')\`\n  ${state.filename}`);
                }
                const spec = (init as any).arguments[0].value;
                if (typeof spec !== 'string') break;

                const globResult = fetchContent(spec, { namespace, filename: state.filename, projectRoot: compileOptions.astroConfig.projectRoot });

                let imports = '';
                for (const importStatement of globResult.imports) {
                  imports += importStatement + '\n';
                }

                createCollection =
                  imports + '\nexport ' + createCollection.substring(0, declaration.start || 0) + globResult.code + createCollection.substring(declaration.end || 0);
              }
              break;
            }
          }
        },
      });
    }

    // Astro.fetchContent()
    for (const [namespace, { spec }] of contentImports.entries()) {
      const globResult = fetchContent(spec, { namespace, filename: state.filename, projectRoot: compileOptions.astroConfig.projectRoot });
      for (const importStatement of globResult.imports) {
        state.importExportStatements.add(importStatement);
      }
      contentCode += globResult.code;
    }

    script = propsStatement + contentCode + babelGenerator(program).code;
  }

  return {
    script,
    componentPlugins,
    createCollection: createCollection || undefined,
  };
}

/** Compile styles */
function compileCss(style: Style, state: CodegenState) {
  walk(style, {
    enter(node: TemplateNode) {
      if (node.type === 'Style') {
        state.css.push(node.content.styles); // if multiple <style> tags, combine together
        this.skip();
      }
    },
    leave(node: TemplateNode) {
      if (node.type === 'Style') {
        this.remove(); // this will be optimized in a global CSS file; remove so it‘s not accidentally inlined
      }
    },
  });
}

/** Compile page markup */
function compileHtml(enterNode: TemplateNode, state: CodegenState, compileOptions: CompileOptions) {
  const { components, css, importExportStatements, dynamicImports, filename } = state;
  const { astroConfig } = compileOptions;

  let outSource = '';
  walk(enterNode, {
    enter(node: TemplateNode, parent: TemplateNode) {
      switch (node.type) {
        case 'Expression': {
          let children: string[] = [];
          for (const child of node.children || []) {
            children.push(compileHtml(child, state, compileOptions));
          }
          let raw = '';
          let nextChildIndex = 0;
          for (const chunk of node.codeChunks) {
            raw += chunk;
            if (nextChildIndex < children.length) {
              raw += children[nextChildIndex++];
            }
          }
          // TODO Do we need to compile this now, or should we compile the entire module at the end?
          let code = compileExpressionSafe(raw).trim().replace(/\;$/, '');
          outSource += `,(${code})`;
          this.skip();
          break;
        }
        case 'MustacheTag':
        case 'Comment':
          return;
        case 'Fragment':
          break;
        case 'Slot':
        case 'Head':
        case 'InlineComponent':
        case 'Title':
        case 'Element': {
          const name: string = node.name;
          if (!name) {
            throw new Error('AHHHH');
          }
          const attributes = getAttributes(node.attributes);

          outSource += outSource === '' ? '' : ',';
          if (node.type === 'Slot') {
            outSource += `(children`;
            return;
          }
          const COMPONENT_NAME_SCANNER = /^[A-Z]/;
          if (!COMPONENT_NAME_SCANNER.test(name)) {
            outSource += `h("${name}", ${attributes ? generateAttributes(attributes) : 'null'}`;
            if (state.markers.insideMarkdown) {
              outSource += `,h(__astroMarkdownRender, null`
            }
            return;
          }
          const [componentName, componentKind] = name.split(':');
          const componentImportData = components[componentName];
          if (!componentImportData) {
            throw new Error(`Unknown Component: ${componentName}`);
          }
          if (componentImportData.type === '.astro' && componentImportData.url.startsWith('astro/components')) {
            if (componentName === 'Markdown') {
              const attributeStr = attributes ? generateAttributes(attributes) : 'null';
              state.markers.insideMarkdown = attributeStr;
              outSource += `h(__astroMarkdownRender, ${attributeStr}`
              return;
            }
          }
          const { wrapper, wrapperImport } = getComponentWrapper(name, components[componentName], { astroConfig, dynamicImports, filename });
          if (wrapperImport) {
            importExportStatements.add(wrapperImport);
          }

          outSource += `h(${wrapper}, ${attributes ? generateAttributes(attributes) : 'null'}`;

          if (state.markers.insideMarkdown) {
            const attributeStr = state.markers.insideMarkdown;
            outSource += `,h(__astroMarkdownRender, ${attributeStr}`
          }
          return;
        }
        case 'Attribute': {
          this.skip();
          return;
        }
        case 'Style': {
          css.push(node.content.styles); // if multiple <style> tags, combine together
          this.skip();
          return;
        }
        case 'CodeFence': {
          outSource += ',' + JSON.stringify(node.raw);
          return;
        }
        case 'Text': {
          const text = getTextFromAttribute(node);
          // Whitespace is significant if we are immediately inside of <Markdown>,
          // but not if we're inside of another component in <Markdown>
          if (parent.name !== 'Markdown' && !text.trim()) {
            return;
          }
          outSource += ',' + JSON.stringify(text);
          return;
        }
        default:
          throw new Error('Unexpected (enter) node type: ' + node.type);
      }
    },
    leave(node, parent, prop, index) {
      switch (node.type) {
        case 'Text':
        case 'CodeFence':
        case 'Attribute':
        case 'Comment':
        case 'Fragment':
        case 'Expression':
        case 'MustacheTag':
          return;
        case 'Slot':
        case 'Head':
        case 'Body':
        case 'Title':
        case 'Element':
        case 'InlineComponent': {
          if (node.type === 'InlineComponent' && node.name === 'Markdown') {
            state.markers.insideMarkdown = false;
          }
          if (state.markers.insideMarkdown) {
            outSource += ')';
          }
          outSource += ')';
          return;
        }
        case 'Style': {
          this.remove(); // this will be optimized in a global CSS file; remove so it‘s not accidentally inlined
          return;
        }
        default:
          throw new Error('Unexpected (leave) node type: ' + node.type);
      }
    },
  });

  return outSource;
}

/**
 * Codegen
 * Step 3/3 in Astro SSR.
 * This is the final pass over a document AST before it‘s converted to an h() function
 * and handed off to Snowpack to build.
 * @param {Ast} AST The parsed AST to crawl
 * @param {object} CodeGenOptions
 */
export async function codegen(ast: Ast, { compileOptions, filename }: CodeGenOptions): Promise<TransformResult> {
  await eslexer.init;

  const state: CodegenState = {
    filename,
    components: {},
    css: [],
    markers: {
      insideMarkdown: false
    },
    importExportStatements: new Set(),
    dynamicImports: new Map()
  };

  const { script, componentPlugins, createCollection } = compileModule(ast.module, state, compileOptions);
  state.dynamicImports = await acquireDynamicComponentImports(componentPlugins, compileOptions.resolvePackageUrl);

  compileCss(ast.css, state);

  const html = compileHtml(ast.html, state, compileOptions);

  return {
    script: script,
    imports: Array.from(state.importExportStatements),
    html,
    css: state.css.length ? state.css.join('\n\n') : undefined,
    createCollection,
  };
}
