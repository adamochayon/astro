import './custom-elements.shim.js';

class MyElement extends HTMLElement {
  connectedCallback() {
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `<span id="custom">Hello from a custom element!</span>`;
    this.innerHTML = `<div id="custom-light">Light dom!</div>`
  }
}

customElements.define('my-element', MyElement);

export default MyElement;