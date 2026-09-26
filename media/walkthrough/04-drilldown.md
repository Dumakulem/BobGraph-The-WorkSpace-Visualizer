# Drill into a File

Click any **file** node in the workspace graph and the view switches to that file's
flowchart: the actual logic, laid out top to bottom with `dagre` instead of the free-form
`cose` layout used for the workspace. A single click or a double-click both work.

You will see a breadcrumb above the graph:

```
Workspace > todo-app.js
```

That tells you which file you are inside and gives you a way back. Click
**← Back to Workspace** to return to the overview. **Refresh Graph** re-runs the flowchart
layout if the steps look cramped.

If a file has no flowchart data yet, the panel keeps you in the workspace view and shows the
reason in the details panel - you are never left on a half-loaded screen.
