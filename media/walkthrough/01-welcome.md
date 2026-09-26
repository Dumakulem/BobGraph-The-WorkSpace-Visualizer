# Welcome to BOB AI - Workspace Visualizer

Reading an unfamiliar codebase means opening files one at a time and guessing how they fit
together. This extension draws the project as a graph instead, and puts an AI-written
pseudocode summary of whatever you click one keystroke away.

## The two views

**Workspace Graph** - the whole project at a glance. One node per file, edges showing which
files import which.

**File Flowchart** - the logic inside a single file, as Start / Decision / End steps. Click
any file node in the workspace graph to jump into it.

## Getting around

| Panel | What it holds |
|---|---|
| Left | Controls (model depth, refresh) |
| Center | The graph, plus a breadcrumb when you are inside a file |
| Right | Details for the node you clicked, and a placeholder for the Bob Agent |

Start with the next step to open the visualizer.
