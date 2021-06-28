

function check(Component) {
  if(typeof Component === 'function' && globalThis.HTMLElement.isPrototypeOf(Component)) {
    return true;
  }
  return false;
}

function renderToStaticMarkup(Component) {
  console.log('trying to render...')
  if(typeof Component === 'string') {
    const tagName = Component;
    Component = customElements.get(tagName);
  }
  const el = new Component();
  el.connectedCallback();
  const html = `<${el.localName}><template shadowroot="open">${el.shadowRoot.innerHTML}</template>${el.innerHTML}</${el.localName}>`
  return {
    html
  };
}

export default {
  check,
  renderToStaticMarkup
}