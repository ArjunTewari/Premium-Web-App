---
name: React component-in-component remount bug
description: Components defined inside a parent function are recreated on every render, causing React to treat them as new types and unmount/remount children — input focus is the telltale symptom.
---

## Rule
Never define a React component (function returning JSX) inside another component's function body. Always declare them at module level.

**Why:** React identifies component types by reference equality. Each render of the parent creates a new function reference for the inner component, so React sees a *different* component type, unmounts the old tree, and mounts a new one — destroying any DOM state (cursor position, focus, scroll) held by children.

**How to apply:** The symptom is an `<input>` that loses focus after a single keystroke, or any element that seems to reset on every state change. Grep for `const Foo = ({…}) =>` or `function Foo({…})` inside another component's body. Move them outside (to module level) and check they only depend on module-level constants, not on closure variables from the parent — if they need parent state, pass it as props.
