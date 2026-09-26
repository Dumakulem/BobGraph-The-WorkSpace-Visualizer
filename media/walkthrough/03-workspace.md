# Read the Workspace Graph

Every rectangle in the center panel is a file. The arrows between them are relationships:

| Edge | Meaning |
|---|---|
| `imports` | This file pulls in that file |
| `contains` | A class or function belongs to that file |
| `calls` | That function calls this one |

Nodes are colour-coded by kind - files are grey, classes blue, methods indigo, functions
green. A red diamond is a decision point and a gold pill is the start or end of a flow, both
of which only appear once you are inside a file.

**Hover** a node to highlight its edges. **Click** one to load its details into the right
panel, and - if it is a file - to drill into its flowchart.

Press **Refresh Graph** in the left panel to re-run the layout if nodes end up overlapping.
