/**
 * Webview frontend: renders the workspace graph and per-file flowcharts.
 * See ARCHITECTURE.md for the data contract and the host<->webview message flow.
 */

document.addEventListener('DOMContentLoaded', () => {
    // dagre needs all three of these to work. cytoscape-dagre captures window.dagre
    // when it loads, so script order in webview.html matters.
    let hasDagre = false;
    if (typeof cytoscape === 'undefined') {
        console.error("Cytoscape.js failed to load from CDN");
    } else if (typeof dagre === 'undefined' || typeof cytoscapeDagre === 'undefined') {
        console.error("cytoscape-dagre failed to load from CDN; dagre layouts are unavailable");
    } else {
        cytoscape.use(cytoscapeDagre);
        hasDagre = true;
        console.log("Dagre layout registered");
    }

    let cy = null;
let currentView = 'workspace';
let currentFile = null;
let isLoading = false;

    // cose runs a physics simulation, so its cost grows steeply with node count and a
    // big real workspace can lock the webview up for minutes. Past this threshold we
    // still render every node but swap in the cheap grid layout instead.
    const COSE_NODE_LIMIT = 400;
    const COSE_LIMIT_MESSAGE =
        'This graph has more than ' + COSE_NODE_LIMIT + ' nodes, so the grid layout is used ' +
        'instead of the physics layout, which would take too long. Drill into a single file ' +
        'for a readable flow.';

    /*
     * Cytoscape is not forgiving about the model it is handed:
     *   - an edge pointing at a node that does not exist makes it THROW, which takes the
     *     entire graph down over one bad reference;
     *   - two nodes with the same id are silently merged into one, so data disappears with
     *     no warning at all.
     * Real Bob 2.0 output will not be this tidy, so normalise it here rather than trusting
     * the producer. Returns the cleaned model plus a human-readable list of what was wrong,
     * which the caller surfaces instead of failing.
     */
    function sanitizeModel(raw) {
        const warnings = [];
        const nodesIn = Array.isArray(raw?.nodes) ? raw.nodes : [];
        const edgesIn = Array.isArray(raw?.edges) ? raw.edges : [];

        if (!Array.isArray(raw?.nodes)) {
            warnings.push('the "nodes" field was missing or not an array');
        }
        if (!Array.isArray(raw?.edges)) {
            warnings.push('the "edges" field was missing or not an array');
        }

        const seen = new Set();
        const droppedEdges = [];
        const nodes = [];
        const edges = [];

        nodesIn.forEach((node, index) => {
            if (!node || typeof node !== 'object') {
                return;
            }
            // The label is read from `name`, but accept `label` too: the two names differ
            // across the model and Cytoscape, and a mismatch renders every node blank.
            const label = node.name ?? node.label ?? node.id ?? `node-${index}`;
            if (node.name === undefined && node.label !== undefined) {
                warnings.push(`node "${label}" used "label"; the contract expects "name"`);
            }

            let id = node.id;
            if (id === undefined || id === null || id === '') {
                id = `node-${index}`;
                warnings.push(`a node had no id and was renamed "${id}"`);
            } else {
                id = String(id);
                if (seen.has(id)) {
                    // Cytoscape would merge these silently, so surface it instead.
                    warnings.push(`duplicate node id "${id}" was dropped`);
                    return;
                }
            }
            seen.add(id);

            nodes.push({
                id,
                label: String(label),
                type: node.type ?? 'file',
                pseudocode: node.pseudocode ?? '',
                filePath: node.filePath ?? '',
                line: Number.isFinite(node.line) ? node.line : 0,
                flowchart: node.flowchart
            });
        });

        edgesIn.forEach(edge => {
            if (!edge || typeof edge !== 'object') {
                return;
            }
            const source = edge.source === undefined ? null : String(edge.source);
            const target = edge.target === undefined ? null : String(edge.target);
            if (!seen.has(source) || !seen.has(target)) {
                droppedEdges.push(`${source ?? '?'} -> ${target ?? '?'}`);
                return;
            }
            const relation = edge.relation ?? 'related';
            edges.push({ source, target, relation });
        });

        // A type with no entry in nodeStyles still renders, but with no colour or shape,
        // so it comes out as an unstyled default blob. That reads as a frontend bug.
        const unknownTypes = new Set(
            nodes.map(n => n.type).filter(t => !Object.prototype.hasOwnProperty.call(nodeStyles, t))
        );
        if (unknownTypes.size > 0) {
            warnings.push(
                `unrecognised node type(s) will render unstyled: ${[...unknownTypes].join(', ')}. ` +
                `Known types: ${Object.keys(nodeStyles).join(', ')}`
            );
        }

        if (nodes.length === 0) {
            warnings.push('the model contained no nodes, so there is nothing to draw');
        }

        if (droppedEdges.length > 0) {
            warnings.push(
                `${droppedEdges.length} edge(s) referenced a node that does not exist and were ` +
                `dropped: ${droppedEdges.slice(0, 5).join(', ')}${droppedEdges.length > 5 ? ', ...' : ''}`
            );
        }

        return { model: { nodes, edges }, warnings };
    }

    // Cytoscape paints to a canvas, so it cannot resolve CSS custom properties itself.
    // Read the value the host injected and hand it over as a concrete colour. Guarded
    // because a throw here would abort initGraph and leave the panel blank.
    function themeColor(variable, fallback) {
        try {
            const value = getComputedStyle(document.body).getPropertyValue(variable).trim();
            return value || fallback;
        } catch (e) {
            return fallback;
        }
    }

    // Colours come from the --accent-* palette in style.css, not from literals here.
    // The hex is only a fallback for when style.css has not loaded. Keeping the two in
    // step matters: this file used to carry its own copies, and a palette change in the
    // CSS silently left the graph in the old colours.
    const nodeStyles = {
        file: {
            background: themeColor('--accent-slate', '#64748b'),
            shape: 'rectangle',
            label: 'font-size:12px; color:#ffffff; font-weight:bold; text-valign:center; text-halign:center;',
            width: 140,
            height: 50
        },
        class: {
            background: themeColor('--accent-blue', '#007acc'),
            shape: 'round-rectangle',
            label: 'font-size:12px; color:#ffffff; font-weight:bold; text-valign:center; text-halign:center;',
            width: 120,
            height: 50
        },
        method: {
            background: themeColor('--accent-indigo', '#5865f2'),
            shape: 'ellipse',
            label: 'font-size:11px; color:#ffffff; text-valign:center; text-halign:center;',
            width: 100,
            height: 40
        },
        function: {
            background: themeColor('--accent-green', '#4ade80'),
            shape: 'ellipse',
            label: 'font-size:11px; color:#000000; text-valign:center; text-halign:center;',
            width: 100,
            height: 40
        },
        start_end: {
            background: themeColor('--accent-gold', '#d4af37'),
            shape: 'round-rectangle',
            label: 'font-size:12px; color:#000000; font-weight:bold; text-valign:center; text-halign:center;',
            width: 100,
            height: 40
        },
        decision: {
            background: themeColor('--accent-red', '#e14b4b'),
            shape: 'diamond',
            label: 'font-size:11px; color:#ffffff; text-valign:center; text-halign:center;',
            width: 120,
            height: 120
        }
    };

    // A null colour means "resolve from the host theme" and is filled in by initGraph.
    // These two are neutral structural edges that would otherwise vanish on a light
    // theme. calls/imports stay fixed: they are semantic accents, not theme chrome.
    const edgeStyles = {
        contains: { color: null, themeVar: '--vscode-editorWidget-border', fallback: '#3c3c3c', width: 2, lineStyle: 'solid', targetArrow: 'triangle' },
        calls: { color: '#007acc', width: 1.5, lineStyle: 'dashed', targetArrow: 'triangle' },
        imports: { color: '#64748b', width: 1, lineStyle: 'solid', targetArrow: 'tee' },
        flow: { color: null, themeVar: '--vscode-editor-foreground', fallback: '#ffffff', width: 2, lineStyle: 'solid', targetArrow: 'triangle' }
    };

    function createElements(model) {
        const elements = [];
        model.nodes.forEach(node => {
            elements.push({
                data: {
                    id: node.id,
                    // Sanitized models carry `label`; raw ones carry `name`. Accept both so
                    // this works whether the model came through sanitizeModel or not.
                    label: node.label ?? node.name ?? node.id,
                    type: node.type,
                    pseudocode: node.pseudocode,
                    filePath: node.filePath,
                    line: node.line,
                    flowchart: node.flowchart
                }
            });
        });
        model.edges.forEach(edge => {
            elements.push({
                data: {
                    id: `${edge.source}->${edge.target}:${edge.relation}`,
                    source: edge.source,
                    target: edge.target,
                    relation: edge.relation
                }
            });
        });
        return elements;
    }

    function getLayoutOptions(layoutType, nodeCount = 0) {
        if (layoutType === 'dagre') {
            if (!hasDagre) {
                console.warn("dagre unavailable, falling back to cose for this view");
                layoutType = 'cose';
            } else {
                return { name: 'dagre', rankDir: 'TB', nodeSep: 50, rankSep: 100, animate: false };
            }
        }
        if (layoutType === 'cose' && nodeCount > COSE_NODE_LIMIT) {
            console.warn(`${nodeCount} nodes exceeds the cose limit of ${COSE_NODE_LIMIT}; using grid`);
            return { name: 'grid', animate: false, padding: 40, avoidOverlap: true };
        }
        return {
            name: 'cose',
            padding: 50,
            nodeOverlap: 20,
            componentSpacing: 120,
            randomize: false,
            idealEdgeLength: 100,
            animate: false
        };
    }

    function initGraph(model, layoutType = 'cose') {
        const elements = createElements(model);
        const nodeCount = elements.filter(el => !el.data || el.data.source === undefined).length;
        const downgraded = layoutType === 'cose' && nodeCount > COSE_NODE_LIMIT;
        const layout = getLayoutOptions(layoutType, nodeCount);
        const borderColor = themeColor('--vscode-editorWidget-border', '#3c3c3c');

        if (cy) {
            cy.destroy();
        }

        cy = cytoscape({
            container: document.getElementById('cy'),
            elements: elements,
            // Nodes are deliberately not draggable. Cytoscape suppresses the `tap` event
            // when a press turns into a drag, so a grabbable node makes "click a file and
            // nothing happens" a real possibility - and dragging buys nothing in a
            // read-only viewer. Panning the background is unaffected: that is container
            // level, not node level.
            autoungrabify: true,
            style: [
                {
                    selector: 'node',
                    style: {
                        'label': 'data(label)',
                        'text-outline-width': 0,
                        'text-outline-color': 'transparent',
                        'text-wrap': 'wrap',
                        'text-max-width': 'wrap'
                    }
                },
                ...Object.entries(nodeStyles).map(([type, style]) => ({
                    selector: `node[type="${type}"]`,
                    style: style
                })),
                {
                    selector: 'edge',
                    style: {
                        'width': 2,
                        'curve-style': 'bezier',
                        'target-arrow-shape': 'triangle',
                        'line-color': borderColor,
                        'target-arrow-color': borderColor,
                        'font-size': '9px',
                        'label': 'data(relation)',
                        'text-rotation': 'autorotate',
                        'text-margin-y': -10
                    }
                },
                ...Object.entries(edgeStyles).map(([rel, style]) => ({
                    selector: `edge[relation="${rel}"]`,
                    style: {
                        'line-color': style.color ?? themeColor(style.themeVar, style.fallback),
                        'target-arrow-color': style.color ?? themeColor(style.themeVar, style.fallback),
                        'target-arrow-shape': style.targetArrow,
                        'width': style.width,
                        'line-style': style.lineStyle
                    }
                })),
                {
                    selector: ':selected',
                    style: {
                        'border-width': 3,
                        'border-color': themeColor('--vscode-focusBorder', '#ffffff'),
                        'border-opacity': 0.8
                    }
                }
            ],
            layout: layout
        });

        function onNodeActivate(evt) {
            const data = evt.target.data();
            showNodeDetails(data);

            if (currentView !== 'workspace') {
                // Already inside a flowchart. Drilling again would be meaningless, and the
                // Back button is the way out.
                return;
            }
            if (data.type !== 'file') {
                // Say why nothing opened. Silently doing nothing here is what made this
                // look like a broken extension.
                console.info(
                    `"${data.label}" is a ${data.type} node; only file nodes open a flowchart.`
                );
                return;
            }

            renderFlowchart(data.flowchart ?? data.id, data.label);
        }

        cy.on('tap', 'node', onNodeActivate);
        // A double click is a separate event in Cytoscape, and it is what people reach for
        // first, so it is wired explicitly rather than relying on `tap` firing twice.
        // When both fire for one double click the second is absorbed by the isLoading guard
        // inside renderFlowchart, because that flag is set before the first await.
        cy.on('dbltap', 'node', onNodeActivate);

        // Cytoscape draws to a canvas, so hover affordance has to be set by hand.
        cy.on('mouseover', 'node', () => setCanvasCursor('pointer'));
        cy.on('mouseout', 'node', () => setCanvasCursor(''));

        function setCanvasCursor(value) {
            const container = cy && cy.container ? cy.container()[0] : null;
            if (container && container.style) {
                container.style.cursor = value;
            }
        }

        return downgraded;
    }

    function showLoadError(message, onRetry) {
        const infoDiv = document.getElementById('nodeInfo');
        infoDiv.textContent = '';
        const empty = document.createElement('div');
        empty.className = 'empty-state error-state';
        empty.textContent = message;
        infoDiv.append(empty);

        if (onRetry) {
            const retry = document.createElement('button');
            retry.className = 'btn btn-secondary error-retry';
            retry.textContent = 'Retry';
            retry.addEventListener('click', onRetry);
            infoDiv.append(retry);
        }
    }

    function showNote(message) {
        const infoDiv = document.getElementById('nodeInfo');
        infoDiv.textContent = '';
        const note = document.createElement('div');
        note.className = 'empty-state';
        note.textContent = message;
        infoDiv.append(note);
    }

    // Problems in the incoming model are shown rather than thrown, so a backend defect
    // degrades the graph instead of blanking the panel.
    function showWarnings(warnings) {
        const infoDiv = document.getElementById('nodeInfo');
        infoDiv.textContent = '';
        const note = document.createElement('div');
        note.className = 'empty-state warning-state';
        note.textContent = `The graph data had ${warnings.length} problem(s) and was repaired where possible:`;
        infoDiv.append(note);
        warnings.forEach(warning => {
            const item = document.createElement('div');
            item.className = 'warning-item';
            item.textContent = `• ${warning}`;
            infoDiv.append(item);
        });
    }

    async function fetchModel(uri, label, timeoutMs = 5000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(uri, { signal: controller.signal });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status} while loading ${label}`);
            }
            return await response.json();
        } catch (e) {
            if (e.name === 'AbortError') {
                throw new Error(`timed out after ${timeoutMs}ms while loading ${label}`);
            }
            throw e;
        } finally {
            clearTimeout(timer);
        }
    }

    function setBreadcrumb(text) {
        const breadcrumb = document.getElementById('breadcrumb');
        if (text) {
            document.getElementById('breadcrumbText').innerText = text;
            breadcrumb.style.display = 'flex';
        } else {
            breadcrumb.style.display = 'none';
        }
    }

    // currentView and the breadcrumb are committed only after a load succeeds, so a
    // failed drill-down leaves the workspace view usable and retryable.
    async function renderWorkspaceGraph(model) {
        if (isLoading) {
            return;
        }
        isLoading = true;

        try {
            const raw = model ?? await fetchModel(window.MOCK_DATA_URI || 'workspace-graph.json', 'workspace graph');
            const { model: data, warnings } = sanitizeModel(raw);
            const downgraded = initGraph(data, 'cose');
            currentView = 'workspace';
            currentFile = null;
            setBreadcrumb(null);
            if (warnings.length > 0) {
                console.warn('Workspace model needed repair:', warnings);
                showWarnings(warnings);
            } else if (downgraded) {
                showNote(COSE_LIMIT_MESSAGE);
            }
        } catch (e) {
            console.error("Workspace Graph Load Error:", e);
            showLoadError(
                `Could not load the workspace graph: ${e.message}`,
                () => renderWorkspaceGraph()
            );
        } finally {
            isLoading = false;
        }
    }

    async function renderFlowchart(fileId, fileName) {
        if (isLoading) {
            return;
        }
        isLoading = true;
        setBreadcrumb(`Loading ${fileName}...`);

        try {
            const baseUri = window.MOCK_DATA_URI || 'workspace-graph.json';
            const lastSlash = baseUri.lastIndexOf('/');
            const folderUri = lastSlash >= 0 ? baseUri.substring(0, lastSlash + 1) : './';
            const data = await fetchModel(`${folderUri}flowcharts/${fileId}.json`, `flowchart for ${fileName}`);
            const { model: clean, warnings } = sanitizeModel(data);
            initGraph(clean, 'dagre');
            currentView = 'flowchart';
            currentFile = { fileId, fileName };
            setBreadcrumb(`Workspace > ${fileName}`);
            if (warnings.length > 0) {
                console.warn('Flowchart model needed repair:', warnings);
                showWarnings(warnings);
            }
        } catch (e) {
            console.error("Flowchart Load Error:", e);
            currentView = 'workspace';
            currentFile = null;
            setBreadcrumb(null);
            showLoadError(
                `Could not load the flowchart for ${fileName}: ${e.message}`,
                () => renderFlowchart(fileId, fileName)
            );
        } finally {
            isLoading = false;
        }
    }

    function showNodeDetails(data) {
        const infoDiv = document.getElementById('nodeInfo');
        infoDiv.textContent = '';

        const header = document.createElement('div');
        header.className = 'node-header';

        const badge = document.createElement('span');
        badge.className = 'node-type-badge';
        badge.textContent = data.type ?? 'unknown';

        const name = document.createElement('span');
        name.className = 'node-name';
        name.textContent = data.label ?? '';

        header.append(badge, name);

        const path = document.createElement('div');
        path.className = 'node-path';
        path.textContent = `${data.filePath}:${data.line}`;

        const pseudocode = document.createElement('div');
        pseudocode.className = 'pseudocode-content';
        pseudocode.textContent = data.pseudocode ?? '';

        infoDiv.append(header, path, pseudocode);

        if (data.filePath) {
            const openBtn = document.createElement('button');
            openBtn.className = 'btn btn-full';
            openBtn.textContent = 'Open in IDE';
            openBtn.dataset.filePath = data.filePath;
            openBtn.dataset.line = String(data.line ?? 1);
            infoDiv.append(openBtn);
        }
    }

    function openFile(filePath, line) {
        window.vscode?.postMessage({
            type: 'openFile',
            filePath: filePath,
            line: line
        });
    }

    window.addEventListener('message', event => {
        const message = event.data;
        if (message && message.type === 'loadModel') {
            renderWorkspaceGraph(message.payload);
        }
    });

    document.getElementById('nodeInfo').addEventListener('click', event => {
        const target = event.target;
        if (target instanceof HTMLElement && target.matches('button[data-file-path]')) {
            openFile(target.dataset.filePath, Number(target.dataset.line));
        }
    });

    document.getElementById('backBtn').addEventListener('click', () => {
        renderWorkspaceGraph();
    });

    // Re-fetches the data for the current view rather than only re-running the layout, so
    // it also picks up files that changed on disk and recovers a load that failed earlier.
    document.getElementById('refreshBtn').addEventListener('click', () => {
        if (isLoading) {
            return;
        }
        if (currentView === 'flowchart' && currentFile) {
            renderFlowchart(currentFile.fileId, currentFile.fileName);
        } else {
            renderWorkspaceGraph();
        }
    });

    renderWorkspaceGraph();
});
