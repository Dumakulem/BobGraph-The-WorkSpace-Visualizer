# Read Pseudocode and Jump to Source

Clicking any node fills the right-hand panel with three things:

1. **A type badge and name** - what kind of node this is.
2. **The file path and line** it came from.
3. **The pseudocode** - a plain-language summary of what that block does, written by
   IBM Bob 2.0 rather than copied from the source.

Then press **Open in IDE** to jump straight to that file with the cursor on the right line.
This is the fast path the extension exists for: skim the graph, read the summary, land
exactly where you need to be.

## What is not here yet

The **Bob Agent** panel below the details is a placeholder, as is **Export JSON** in the
left sidebar. Both are planned.

## Where to go next

`ARCHITECTURE.md` in the extension folder explains the data contract and how to wire real
Bob 2.0 output into the `{type:'loadModel'}` message the frontend already handles.
