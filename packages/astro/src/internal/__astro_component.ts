import type { Renderer, SelectedRenderer } from '../@types/astro';
import hash from 'shorthash';
import { valueToEstree, Value } from 'estree-util-value-to-estree';
import { generate } from 'astring';
import * as astro from './renderer-astro';
import * as astroHtml from './renderer-html';

// A more robust version alternative to `JSON.stringify` that can handle most values
// see https://github.com/remcohaszing/estree-util-value-to-estree#readme
const serialize = (value: Value) => generate(valueToEstree(value));

let rendererSources: string[] = [];
let renderers: Renderer[] = [];
let rendererOptions: any[] = [];

export function setRenderers(_rendererSources: string[], _renderers: Renderer[], _rendererOptions: any[]) {
  rendererSources = [''].concat(_rendererSources);
  renderers = [astro as Renderer].concat(_renderers);
  rendererOptions = [null].concat(_rendererOptions);
}

function isCustomElementTag(name: string | Function) {
  return typeof name === 'string' && /-/.test(name);
}

const rendererCache = new Map<any, SelectedRenderer>();

/** For a given component, resolve the renderer. Results are cached if this instance is encountered again */
async function resolveRenderer(Component: any, props: any = {}, children?: string) {
  if (rendererCache.has(Component)) {
    return rendererCache.get(Component);
  }

  const errors: Error[] = [];
  let i = 0;
  for (const __renderer of renderers) {
    // Yes, we do want to `await` inside of this loop!
    // __renderer.check can't be run in parallel, it
    // returns the first match and skips any subsequent checks
    try {
      const options = rendererOptions[i];
      const shouldUse: boolean = await __renderer.check(Component, props, children, options);

      if (shouldUse) {
        const selectedRenderer = Object.create(__renderer, {
          options: {
            value: options
          }
        }) as SelectedRenderer;
        rendererCache.set(Component, selectedRenderer);
        return selectedRenderer;
      }
    } catch (err) {
      errors.push(err);
    }
    i++;
  }

  if (errors.length) {
    // For now just throw the first error we encounter.
    throw errors[0];
  }
}

interface AstroComponentProps {
  displayName: string;
  hydrate?: 'load' | 'idle' | 'visible';
  componentUrl?: string;
  componentExport?: { value: string; namespace?: boolean };
}

interface HydrateScriptOptions {
  Component: string | Function;
  renderer: SelectedRenderer;
  astroId: string;
  props: any;
  children: string;
}

/** For hydrated components, generate a <script type="module"> to load the component */
async function generateHydrateScript({ Component, children, renderer, astroId, props }: HydrateScriptOptions, { hydrate, componentUrl, componentExport }: Required<AstroComponentProps>) {
  if(!componentUrl && !componentExport && renderer.getComponentInfo) {
    const info = await renderer.getComponentInfo(Component, props, children, renderer.options);
    componentUrl = info.url;
    componentExport = info.export;
  }

  const rendererSource = rendererSources[renderers.findIndex((r) => r === renderer)];

  const hydrationSource = renderer.hydrationMethod === 'self' ?
    `
  const { default: hydrate } = await import("${rendererSource}");
  return (el, children) => hydrate(el, "${componentUrl}")(${serialize(props)}, children);
`.trim() : `
  const [{ ${componentExport.value}: Component }, { default: hydrate }] = await Promise.all([import("${componentUrl}"), import("${rendererSource}")]);
  return (el, children) => hydrate(el)(Component, ${serialize(props)}, children);
`.trim();

  const script = `<script type="module">
import setup from '/_astro_frontend/hydrate/${hydrate}.js';
setup("${astroId}", async () => {
  ${hydrationSource}
});
</script>`;

  return script;
}

const getComponentName = (Component: any, componentProps: any) => {
  if (componentProps.displayName) return componentProps.displayName;
  switch (typeof Component) {
    case 'function':
      return Component.displayName ?? Component.name;
    case 'string':
      return Component;
    default: {
      return Component;
    }
  }
};

export const __astro_component = (Component: any, componentProps: AstroComponentProps = {} as any) => {
  if (Component == null) {
    throw new Error(`Unable to render ${componentProps.displayName} because it is ${Component}!\nDid you forget to import the component or is it possible there is a typo?`);
  } else if (typeof Component === 'string' && !isCustomElementTag(Component)) {
    throw new Error(`Astro is unable to render ${componentProps.displayName}!\nIs there a renderer to handle this type of component defined in your Astro config?`);
  }

  return async (props: any, ..._children: string[]) => {
    const children = _children.join('\n');
    let renderer = await resolveRenderer(Component, props, children);

    if (!renderer) {
      if(isCustomElementTag(Component)) {
        renderer = astroHtml as SelectedRenderer;
      } else {
        // If the user only specifies a single renderer, but the check failed
        // for some reason... just default to their preferred renderer.
        renderer = rendererSources.length === 2 ? Object.create(renderers[1], {
          options: {
            value: rendererOptions[1]
          }
        }) as SelectedRenderer : undefined;
      }

      if (!renderer) {
        const name = getComponentName(Component, componentProps);
        throw new Error(`No renderer found for ${name}! Did you forget to add a renderer to your Astro config?`);
      }
    }
    const { html } = await renderer.renderToStaticMarkup(Component, props, children, renderer.options);
    // If we're NOT hydrating this component, just return the HTML
    if (!componentProps.hydrate) {
      // It's safe to remove <astro-fragment>, static content doesn't need the wrapper
      return html.replace(/\<\/?astro-fragment\>/g, '');
    }

    // If we ARE hydrating this component, let's generate the hydration script
    const astroId = hash.unique(html);
    const script = await generateHydrateScript({ Component, renderer, children, astroId, props }, componentProps as Required<AstroComponentProps>);
    const astroRoot = `<astro-root uid="${astroId}">${html}</astro-root>`;
    return [astroRoot, script].join('\n');
  };
};
