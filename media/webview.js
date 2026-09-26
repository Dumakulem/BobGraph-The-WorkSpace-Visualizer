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
let currentFlowchartModel = null;
let selectedNodeId = null;
let selectedNodeData = null;
let isLoading = false;
    let workspaceModel = null;
    let pendingWorkspaceModel = null;

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
            // `label` is the stored graph contract. Keep accepting `name` for older Bob
            // payloads, but do not report the canonical label field as a repair.
            const label = node.label ?? node.name ?? node.id ?? `node-${index}`;
            if (node.label === undefined && node.name === undefined) {
                warnings.push(`node "${label}" had no label or name; its id was used`);
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
            const sourceValue = edge.from ?? edge.source;
            const targetValue = edge.to ?? edge.target;
            const source = sourceValue === undefined ? null : String(sourceValue);
            const target = targetValue === undefined ? null : String(targetValue);
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

    // Node colours come from the --accent-*-bg palette in style.css; that file is the single
    // source of truth. The hex literals here are fallbacks only — they must match what style.css
    // declares for the same variable so they agree whether CSS loaded or not.
    const nodeStyles = {
        file: {
            'background-color': themeColor('--accent-file-bg', '#1e3a5f'),
            'border-color': '#60a5fa',
            'border-width': 1,
            shape: 'rectangle',
            width: 140,
            height: 50,
            color: '#ffffff',
            'font-size': 12,
            'font-weight': 'bold',
            'text-valign': 'center',
            'text-halign': 'center'
        },
        class: {
            'background-color': themeColor('--accent-class-bg', '#1e1b4b'),
            'border-color': '#a78bfa',
            'border-width': 1,
            shape: 'round-rectangle',
            width: 130,
            height: 50,
            color: '#ffffff',
            'font-size': 12,
            'font-weight': 'bold',
            'text-valign': 'center',
            'text-halign': 'center'
        },
        method: {
            'background-color': themeColor('--accent-function-bg', '#14532d'),
            'border-color': '#4ade80',
            'border-width': 1,
            shape: 'rectangle',
            width: 130,
            height: 50,
            color: '#ffffff',
            'font-size': 12,
            'text-valign': 'center',
            'text-halign': 'center'
        },
        function: {
            'background-color': themeColor('--accent-function-bg', '#14532d'),
            'border-color': '#4ade80',
            'border-width': 1,
            shape: 'rectangle',
            width: 130,
            height: 50,
            color: '#ffffff',
            'font-size': 12,
            'text-valign': 'center',
            'text-halign': 'center'
        },
        start_end: {
            'background-color': themeColor('--accent-start-bg', '#0c4a6e'),
            'border-color': '#00d4ff',
            'border-width': 2,
            shape: 'round-rectangle',
            width: 110,
            height: 44,
            color: '#00d4ff',
            'font-size': 12,
            'font-weight': 'bold',
            'text-valign': 'center',
            'text-halign': 'center'
        },
        decision: {
            'background-color': themeColor('--accent-decision-bg', '#450a0a'),
            'border-color': '#f87171',
            'border-width': 1,
            shape: 'diamond',
            width: 130,
            height: 130,
            color: '#ffffff',
            'font-size': 11,
            'text-valign': 'center',
            'text-halign': 'center'
        },
        property: {
            'background-color': themeColor('--accent-property-bg', '#1c2a1c'),
            'border-color': '#4ade80',
            'border-width': 1,
            shape: 'round-rectangle',
            width: 140,
            height: 36,
            color: '#4ade80',
            'font-size': 10,
            'text-valign': 'center',
            'text-halign': 'center'
        }
    };

    // A null colour means "resolve from the host theme" and is filled in by initGraph.
    const edgeStyles = {
        contains: { color: '#1e2d45', width: 2,   lineStyle: 'solid',  targetArrow: 'triangle' },
        calls:    { color: '#1d6fd8', width: 1.5, lineStyle: 'dashed', targetArrow: 'triangle' },
        imports:  { color: '#4d5666', width: 1,   lineStyle: 'solid',  targetArrow: 'tee'      },
        flow:     { color: '#00d4ff', width: 2,   lineStyle: 'solid',  targetArrow: 'triangle' }
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
                // Do not fit a large flowchart into the whole canvas: that makes every
                // node and label render at a tiny scale. Users can use Fit when they
                // explicitly want the complete overview.
                return { name: 'dagre', rankDir: 'TB', nodeSep: 50, rankSep: 100, fit: false, animate: false };
            }
        }
        if (layoutType === 'cose' && nodeCount > COSE_NODE_LIMIT) {
            console.warn(`${nodeCount} nodes exceeds the cose limit of ${COSE_NODE_LIMIT}; using grid`);
            return { name: 'grid', animate: false, padding: 40, avoidOverlap: true };
        }
        return {
            name: 'cose',
            padding: 50,
            nodeOverlap: 30,
            nodeRepulsion: 9000,
            componentSpacing: 120,
            randomize: true,
            idealEdgeLength: 140,
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
            // Use a stable high-resolution backing store. VS Code webviews can report a
            // transient device ratio while the panel is settling, which leaves canvas text
            // blurry until a later repaint.
            pixelRatio: 2,
            textureOnViewport: false,
            motionBlur: false,
            hideEdgesOnViewport: false,
            hideLabelsOnViewport: false,
            // Allow users to reposition nodes after the initial layout. Cytoscape still
            // emits tap events for clicks that do not move, so selection and drill-down
            // remain available alongside dragging.
            autoungrabify: false,
            // Hard zoom bounds: user cannot scroll past these levels.
            minZoom: 0.15,
            maxZoom: 3,
            style: [
                {
                    selector: 'node',
                    style: {
                        'label': 'data(label)',
                        'font-family': 'Segoe UI, system-ui, sans-serif',
                        'text-outline-width': 0,
                        'text-outline-color': 'transparent',
                        // Ellipsis keeps long filenames inside every node shape, including
                        // the narrower method/function nodes and diamond decisions.
                        'text-wrap': 'ellipsis',
                        'text-max-width': 100,
                        'transition-property': 'border-width, border-color, opacity, background-color',
                        'transition-duration': '150ms'
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
                        'color': themeColor('--vscode-editor-foreground', '#e6edf3'),
                        'text-outline-width': 2,
                        'text-outline-color': themeColor('--vscode-editor-background', '#0d1117'),
                        'text-outline-opacity': 0.75,
                        'text-rotation': 'autorotate',
                        'text-margin-y': -10,
                        // Dashed style + offset lets the rAF loop animate marching ants.
                        'line-style': 'dashed',
                        'line-dash-pattern': [8, 5],
                        'line-dash-offset': 0,
                        'transition-property': 'line-color, target-arrow-color, width, opacity',
                        'transition-duration': '150ms'
                    }
                },
                ...Object.entries(edgeStyles).map(([rel, style]) => ({
                    selector: `edge[relation="${rel}"]`,
                    style: {
                        'line-color': style.color,
                        'target-arrow-color': style.color,
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
                },
                { selector: '.dimmed',         style: { 'opacity': 0.15 } },
                { selector: '.hovered',         style: { 'border-width': 3, 'border-color': '#00d4ff', 'opacity': 1 } },
                { selector: '.neighbour',       style: { 'opacity': 1 } },
                { selector: '.connected-edge',  style: { 'opacity': 1, 'width': 2.5 } },
                { selector: '.pulse',           style: { 'border-width': 5, 'border-color': '#00d4ff', 'border-opacity': 1 } }
            ],
            layout: layout
        });

        if (layoutType === 'dagre' && typeof cy.zoom === 'function' && typeof cy.center === 'function') {
            cy.zoom(1);
            cy.center();
        }

        // A webview panel can resize after Cytoscape has created its canvas (especially
        // while the sidebars and fonts settle). Keep the backing store aligned with the
        // actual container instead of relying on a later user interaction to repaint it.
        const graphContainer = document.getElementById('cy');
        if (typeof ResizeObserver === 'function' && graphContainer) {
            const observer = new ResizeObserver(() => {
                if (cy && cy.container() && cy.container()[0]) {
                    cy.resize();
                }
            });
            observer.observe(graphContainer);
            cy.on('destroy', () => observer.disconnect());
        }

        // Keep the graph from being panned so far off-screen that it disappears.
        // After every pan/zoom event, if the bounding box of all nodes has moved
        // completely outside the viewport, snap it back to fit.
        //
        // Guard flag: cy.animate() fires its own `viewport` events while running,
        // which would re-trigger this handler and start a second animation, creating
        // the infinite diagonal-pan glitch reported in issue #4. Skip the check while
        // a snap-back is already in progress.
        let isSnapping = false;
        cy.on('viewport', () => {
            if (isSnapping) { return; }
            const ext = cy.extent();           // viewport rectangle in model coords
            const bb  = cy.elements().boundingBox(); // nodes bounding box in model coords
            // Check overlap: if the bb is entirely outside the viewport, re-fit.
            const noOverlapH = bb.x2 < ext.x1 || bb.x1 > ext.x2;
            const noOverlapV = bb.y2 < ext.y1 || bb.y1 > ext.y2;
            if (noOverlapH || noOverlapV) {
                isSnapping = true;
                cy.animate({
                    fit: { eles: cy.elements(), padding: 60 },
                    duration: 250,
                    easing: 'ease-out',
                    complete: () => { isSnapping = false; }
                });
            }
        });

        // Single tap: show node details + connected neighbours. Never drills into flowchart.
        cy.on('tap', 'node', (evt) => {
            const node = evt.target;
            const data = node.data();
            selectedNodeId = data.id;
            selectedNodeData = data;
            updateAgentContext(data);
            if (typeof node.addClass === 'function') {
                node.addClass('pulse');
                setTimeout(() => node.removeClass('pulse'), 300);
            }
            // Collect neighbours from the live graph so we can show connections in the panel.
            const neighbours = node.neighbourhood('node').map(n => n.data());
            showNodeDetails(data, neighbours);
            // Workspace nodes are resolved by the host from its active graph. Flowchart
            // nodes are a separate graph, so include their file metadata as the fallback
            // resolution source for explanations.
            window.vscode?.postMessage({
                type: 'nodeClicked',
                nodeId: data.id,
                filePath: data.filePath,
                label: data.label,
                line: data.line
            });
        });

        // Double-tap: drill into the file's flowchart (workspace view only).
        cy.on('dbltap', 'node', (evt) => {
            const data = evt.target.data();
            if (currentView !== 'workspace' || data.type !== 'file') {
                return;
            }
            if (data.flowchart) {
                renderFlowchart(data.flowchart, data.label);
            } else {
                window.vscode?.postMessage({ type: 'requestFlowchart', nodeId: data.id });
            }
        });

        // Cytoscape draws to a canvas, so hover affordance has to be set by hand.
        cy.on('mouseover', 'node', (evt) => {
            const hovered = evt.target;
            cy.elements().addClass('dimmed');
            hovered.addClass('hovered').removeClass('dimmed');
            hovered.connectedEdges().addClass('connected-edge').removeClass('dimmed');
            hovered.neighbourhood('node').addClass('neighbour').removeClass('dimmed');
            setCanvasCursor('pointer');
        });
        cy.on('mouseout', 'node', () => {
            cy.elements().removeClass('dimmed hovered neighbour connected-edge');
            setCanvasCursor('');
        });

        function setCanvasCursor(value) {
            const container = cy && cy.container ? cy.container()[0] : null;
            if (container && container.style) {
                container.style.cursor = value;
            }
        }

        // ── Animated marching-ants on edges ──────────────────────────────────
        // Cytoscape renders to a <canvas>, so CSS animations don't work on edges.
        // Instead we drive line-dash-offset forward each frame via rAF, which makes
        // the dashes appear to march along every edge continuously.
        // Guard: requestAnimationFrame is unavailable in the Node.js test environment.
        if (typeof requestAnimationFrame === 'function') {
            let dashOffset = 0;
            let animFrameId = null;

            function animateEdges() {
                dashOffset = (dashOffset - 1.2) % 60;   // negative = marches forward
                cy.style()
                    .selector('edge')
                    .style({ 'line-dash-offset': dashOffset })
                    .update();
                animFrameId = requestAnimationFrame(animateEdges);
            }

            // Cancel the previous loop if initGraph is called again (e.g. drill-down).
            if (window._edgeAnimFrameId) {
                cancelAnimationFrame(window._edgeAnimFrameId);
            }
            // Start the loop and store the id globally so it survives the next initGraph.
            animFrameId = requestAnimationFrame(animateEdges);
            window._edgeAnimFrameId = animFrameId;
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
            if (model) {
                pendingWorkspaceModel = model;
            }
            return;
        }
        isLoading = true;

        try {
            const raw = model ?? await fetchModel(window.MOCK_DATA_URI || 'workspace-graph.json', 'workspace graph');
            const { model: data, warnings } = sanitizeModel(raw);
            workspaceModel = raw;
            const downgraded = initGraph(data, 'cose');
            currentView = 'workspace';
            currentFile = null;
            currentFlowchartModel = null;
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
            if (pendingWorkspaceModel) {
                const pending = pendingWorkspaceModel;
                pendingWorkspaceModel = null;
                void renderWorkspaceGraph(pending);
            }
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

    // Badge CSS class → node type mapping (mirrors style.css .badge-* classes)
    const badgeClass = {
        start_end: 'badge-start-end',
        file:      'badge-file',
        class:     'badge-class',
        method:    'badge-method',
        function:  'badge-function',
        decision:  'badge-decision'
    };

    function showNodeDetails(data, neighbours = []) {
        const infoDiv = document.getElementById('nodeInfo');
        infoDiv.textContent = '';

        // Show 100% completion badge
        const completionBadge = document.getElementById('completionBadge');
        if (completionBadge) completionBadge.style.display = '';

        const header = document.createElement('div');
        header.className = 'node-header';

        const typeKey = (data.type ?? 'default').replace('-', '_');
        const badge = document.createElement('span');
        badge.className = `node-type-badge ${badgeClass[typeKey] ?? 'badge-default'}`;
        badge.textContent = (data.type ?? 'unknown').replace('_', ' ').toUpperCase();

        const name = document.createElement('span');
        name.className = 'node-name';
        name.textContent = data.label ?? '';

        header.append(badge, name);

        const path = document.createElement('div');
        path.className = 'node-path';
        path.textContent = data.filePath ? `${data.filePath}:${data.line}` : '';

        const pseudocode = document.createElement('div');
        pseudocode.className = 'pseudocode-content';
        pseudocode.textContent = data.pseudocode ?? '';

        infoDiv.append(header, path, pseudocode);

        const explanation = document.createElement('div');
        explanation.id = 'nodeExplanation';
        explanation.className = 'node-explanation';
        explanation.textContent = 'Bob is preparing a summary...';
        infoDiv.append(explanation);

        // Connections section — list every neighbour node so the user can see
        // how this file relates to the rest of the repository at a glance.
        if (neighbours.length > 0) {
            const connTitle = document.createElement('div');
            connTitle.className = 'connections-title';
            connTitle.textContent = 'Connected nodes';
            infoDiv.append(connTitle);

            const connList = document.createElement('ul');
            connList.className = 'connections-list';
            neighbours.forEach(n => {
                const li = document.createElement('li');
                li.className = 'connections-item';
                const nb = document.createElement('span');
                const nTypeKey = (n.type ?? 'default').replace('-', '_');
                nb.className = `node-type-badge ${badgeClass[nTypeKey] ?? 'badge-default'} badge-sm`;
                nb.textContent = (n.type ?? '?').toUpperCase();
                const nl = document.createElement('span');
                nl.textContent = n.label ?? n.id ?? '';
                li.append(nb, nl);
                connList.append(li);
            });
            infoDiv.append(connList);
        }

        // For file nodes in workspace view, invite the user to double-click to open flowchart.
        if (currentView === 'workspace' && data.type === 'file') {
            const hint = document.createElement('div');
            hint.className = 'node-dblclick-hint';
            hint.textContent = '⇥  Double-click to open flowchart';
            infoDiv.append(hint);
        }

        if (data.filePath) {
            const openBtn = document.createElement('button');
            openBtn.className = 'btn btn-open-ide btn-full';
            openBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:13px;height:13px;flex-shrink:0"><path d="M6 3H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3M9 2h5v5M8.5 8.5 14 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Open in IDE`;
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
        } else if (message && message.type === 'explanationLoading') {
            if (message.nodeId === selectedNodeId) {
                const summary = document.getElementById('nodeExplanation');
                if (summary) summary.textContent = 'Bob is preparing a summary...';
            }
        } else if (message && message.type === 'nodeExplanation') {
            if (message.nodeId === selectedNodeId) {
                const summary = document.getElementById('nodeExplanation');
                if (summary) summary.textContent = message.summary;
            }
        } else if (message && message.type === 'agentLoading') {
            if (message.nodeId === selectedNodeId) {
                appendAgentMessage('Bob is thinking...', 'agent-status');
                setAgentBusy(true);
            }
        } else if (message && message.type === 'agentAnswer') {
            if (message.nodeId === selectedNodeId) {
                setAgentName(message.modelName);
                appendAgentMessage(message.answer, 'agent-answer');
                setAgentBusy(false);
            }
        } else if (message && message.type === 'agentError') {
            if (message.nodeId === selectedNodeId) {
                appendAgentMessage(message.message, 'agent-error');
                setAgentBusy(false);
            }
        } else if (message && message.type === 'flowchartData') {
            const result = sanitizeModel(message.graph);
            initGraph(result.model, 'dagre');
            currentView = 'flowchart';
            currentFile = { fileId: message.nodeId, fileName: message.fileName };
            currentFlowchartModel = result.model;
            setBreadcrumb(`Workspace > ${message.fileName}`);
        } else if (message && message.type === 'graphError') {
            if (message.nodeId === selectedNodeId) {
                const summary = document.getElementById('nodeExplanation');
                if (summary) summary.textContent = message.message;
            } else {
                showLoadError(message.message, () => window.vscode?.postMessage({ type: 'requestGraph' }));
            }
        }
    });

    document.getElementById('nodeInfo').addEventListener('click', event => {
        const btn = event.target instanceof HTMLElement
            ? event.target.closest('button[data-file-path]')
            : null;
        if (btn instanceof HTMLElement) {
            openFile(btn.dataset.filePath, Number(btn.dataset.line));
        }
    });

    function updateAgentContext(data) {
        const input = document.getElementById('agentInput');
        const send = document.getElementById('agentSendBtn');
        if (input) input.placeholder = `Ask Bob about ${data.label ?? 'this node'}...`;
        if (send) send.disabled = false;
    }

    function setAgentName(modelName) {
        const title = document.getElementById('agentTitle');
        if (title && typeof modelName === 'string' && modelName.trim()) {
            title.textContent = `${modelName.trim()} Agent`;
        }
    }

    function appendAgentMessage(text, className) {
        const messages = document.getElementById('agentMessages');
        if (!messages) return;
        const empty = messages.querySelector('.agent-empty');
        if (empty) empty.remove();
        const message = document.createElement('div');
        message.className = `agent-message ${className}`;
        message.textContent = text;
        messages.append(message);
        messages.scrollTop = messages.scrollHeight;
    }

    function setAgentBusy(busy) {
        const input = document.getElementById('agentInput');
        const send = document.getElementById('agentSendBtn');
        if (input) input.disabled = busy;
        if (send) {
            send.disabled = busy || !selectedNodeData;
            send.textContent = busy ? 'Thinking...' : 'Ask Bob';
        }
    }

    document.getElementById('agentForm')?.addEventListener('submit', event => {
        event.preventDefault();
        const input = document.getElementById('agentInput');
        const question = input?.value.trim() ?? '';
        if (!question || !selectedNodeData || !selectedNodeId) return;
        appendAgentMessage(question, 'agent-question');
        input.value = '';
        window.vscode?.postMessage({
            type: 'agentQuestion',
            nodeId: selectedNodeId,
            filePath: selectedNodeData.filePath,
            question
        });
    });

    document.getElementById('backBtn')?.addEventListener('click', () => {
        renderWorkspaceGraph();
        window.vscode?.postMessage({ type: 'requestGraph' });
    });

    // ── Zoom controls ────────────────────────────────────────────────────────
    document.getElementById('zoomInBtn')?.addEventListener('click', () => {
        if (!cy) return;
        cy.animate({ zoom: { level: Math.min(cy.zoom() * 1.3, 3), renderedPosition: cy.container().getBoundingClientRect() }, duration: 180 });
    });
    document.getElementById('zoomOutBtn')?.addEventListener('click', () => {
        if (!cy) return;
        cy.animate({ zoom: { level: Math.max(cy.zoom() / 1.3, 0.15), renderedPosition: cy.container().getBoundingClientRect() }, duration: 180 });
    });
    document.getElementById('zoomFitBtn')?.addEventListener('click', () => {
        if (!cy) return;
        cy.animate({ fit: { eles: cy.elements(), padding: 60 }, duration: 220, easing: 'ease-out' });
    });

    // Export JSON: serialise the current graph (nodes + edges) to a downloadable file.
    document.getElementById('exportBtn')?.addEventListener('click', () => {
        if (!cy) {
            return;
        }
        const nodes = cy.nodes().map(n => ({ ...n.data() }));
        const edges = cy.edges().map(e => {
            const d = e.data();
            return { from: d.source, to: d.target, relation: d.relation };
        });
        const payload = JSON.stringify({ nodes, edges }, null, 2);
        const blob = new Blob([payload], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = currentView === 'flowchart' && currentFile
            ? `flowchart-${currentFile.fileId}.json`
            : 'workspace-graph.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    });

    document.getElementById('refreshBtn')?.addEventListener('click', () => {
        if (isLoading) {
            return;
        }
        if (currentView === 'flowchart' && currentFile) {
            if (currentFlowchartModel) {
                initGraph(currentFlowchartModel, 'dagre');
            } else {
                renderFlowchart(currentFile.fileId, currentFile.fileName);
            }
        } else {
            renderWorkspaceGraph();
            window.vscode?.postMessage({ type: 'requestGraph' });
        }
    });

    // Render the bundled graph immediately while the host loads the validated
    // workspace graph. The host response replaces this fallback when available.
    renderWorkspaceGraph();
    window.vscode?.postMessage({ type: 'requestGraph' });
});
