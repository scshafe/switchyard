import { cleanupHydratedDiagram, clearDiagramNodeSelection, hydrateDiagram, selectDiagramNode } from "graphpaper";
import { captureViewerRecord, validateNodeDetails, validateStaticLayoutResult, validateStaticModel } from "./viewer-data.js";
import { staticViewerRenderOptions } from "./viewer-defaults.js";
const mounted = new WeakSet();
const hosts = new WeakMap();
const unavailable = "Details for this version are unavailable.";
let nextMarkerId = 0;
function ownFrozen(value) {
    return Object.freeze(Object.assign(Object.create(null), value));
}
function acquireHost(host) {
    let state = hosts.get(host);
    if (state === undefined) {
        state = { count: 0, added: !host.classList.contains("pipeline-viewer-host") };
        hosts.set(host, state);
        if (state.added)
            host.classList.add("pipeline-viewer-host");
    }
    state.count += 1;
    return () => {
        state.count -= 1;
        if (state.count === 0) {
            if (state.added)
                host.classList.remove("pipeline-viewer-host");
            hosts.delete(host);
        }
    };
}
/** Capture a trusted capability's data method, including class prototype methods. */
function layoutCapability(value, nodeIds) {
    if (value === null || typeof value !== "object")
        throw new Error("layoutEngine must provide a layout method");
    let cursor = value;
    for (let depth = 0; cursor !== null && cursor !== Object.prototype && cursor !== Function.prototype && depth < 16; depth += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(cursor, "layout");
        if (descriptor !== undefined) {
            if (!("value" in descriptor) || typeof descriptor.value !== "function")
                throw new Error("layoutEngine.layout must be a data method");
            const method = descriptor.value;
            return ownFrozen({ async layout(graph) {
                    try {
                        return validateStaticLayoutResult(await Reflect.apply(method, value, [graph]), nodeIds);
                    }
                    catch {
                        throw new Error("Pipeline layout engine failed");
                    }
                } });
        }
        cursor = Object.getPrototypeOf(cursor);
    }
    throw new Error("layoutEngine must provide a layout method");
}
function embeddedModel(container) {
    const scripts = container.querySelectorAll('script[type="application/json"][data-pipeline-model]');
    if (scripts.length !== 1)
        throw new Error("viewer requires exactly one embedded pipeline model or an explicit model option");
    return scripts[0].textContent ?? "";
}
/**
 * Hydrate one static pipeline figure, optionally wiring selection to an
 * authorized details provider. Browser objects and callbacks are trusted;
 * ordinary accessors are refused, but JavaScript cannot detect live Proxies.
 */
export async function mountPipelineViewer(container, options = {}) {
    if (container === null || typeof container !== "object" || container.nodeType !== 1 || !container.isConnected) {
        throw new Error("pipeline viewer container must be a connected element");
    }
    const canvas = container.querySelector("[data-pipeline-canvas]") ?? container;
    const claimed = canvas === container ? [container] : [container, canvas];
    if (claimed.some((element) => mounted.has(element)))
        throw new Error("pipeline viewer is already mounted; destroy it before mounting again");
    const raw = captureViewerRecord(options, ["model", "onSelect", "details", "deepLink", "legendVisible", "layoutEngine"], [], "viewer options");
    for (const key of ["onSelect", "details"]) {
        if (Object.hasOwn(raw, key) && typeof raw[key] !== "function")
            throw new Error(`viewer options.${key} must be a function`);
    }
    if (Object.hasOwn(raw, "legendVisible") && typeof raw.legendVisible !== "boolean")
        throw new Error("viewer options.legendVisible must be boolean");
    let hashParam = "node";
    if (raw.deepLink === false)
        hashParam = null;
    else if (Object.hasOwn(raw, "deepLink")) {
        const link = captureViewerRecord(raw.deepLink, ["param"], [], "viewer options.deepLink");
        if (Object.hasOwn(link, "param")) {
            if (typeof link.param !== "string" || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(link.param)) {
                throw new Error("viewer deepLink.param must be a bounded URL parameter name");
            }
            hashParam = link.param;
        }
    }
    const model = validateStaticModel(Object.hasOwn(raw, "model") ? raw.model : embeddedModel(container));
    const layoutEngine = Object.hasOwn(raw, "layoutEngine") ? layoutCapability(raw.layoutEngine, model.nodes.map((node) => node.id)) : undefined;
    const details = raw.details;
    const onSelect = raw.onSelect;
    const document = container.ownerDocument;
    const window = document.defaultView;
    if (window === null)
        throw new Error("pipeline viewer requires an active document window");
    const originalChildren = Array.from(canvas.childNodes);
    const originalHydrated = container.getAttribute("data-pipeline-hydrated");
    const addedClass = !container.classList.contains("pipeline-viewer");
    const graph = model.metadata.pipeline.graph;
    const byId = new Map(model.nodes.map((node) => [node.id, node]));
    let destroyed = false;
    let ready = false;
    let epoch = 0;
    let selected = null;
    let suppressUrl = false;
    let panel;
    let panelTitle;
    let panelBody;
    let closeButton;
    let releaseHost;
    const element = (tag, className, text) => {
        const value = document.createElement(tag);
        if (className !== undefined)
            value.className = className;
        if (text !== undefined)
            value.textContent = text;
        return value;
    };
    const note = (text) => element("p", "pipeline-details-note", text);
    const table = (rows) => {
        const list = element("dl");
        for (const [label, value] of rows)
            list.append(element("dt", undefined, label), element("dd", undefined, value));
        return list;
    };
    const section = (title, rows) => {
        panelBody.append(element("h3", undefined, title), table(rows));
    };
    function renderDetails(payload) {
        panelBody.replaceChildren();
        if (payload.question !== undefined)
            panelBody.append(element("p", undefined, payload.question));
        section("Sealed node", [
            ["Node", payload.nodeId], ["Kind", payload.sealed.kind],
            ["Reference", `${payload.sealed.ref.id}@${payload.sealed.ref.version}`],
            ["Input", payload.sealed.input], ["Outcomes", payload.sealed.outcomes.join(" | ")],
            ["Maximum attempts", String(payload.sealed.maxAttempts)], ["Lease (ms)", String(payload.sealed.leaseMs)],
            ...(payload.sealed.binding === undefined ? [] : [["Binding", `${payload.sealed.binding.bindingId}@${payload.sealed.binding.version}`]])
        ]);
        if (payload.outputs !== undefined && payload.outputs.length > 0) {
            section("Output contracts", payload.outputs.map((entry) => [entry.outcome, entry.contractId]));
        }
        if (payload.model !== undefined) {
            section("Model", [
                ["Name", payload.model.name], ["Identity", `${payload.model.id}@${payload.model.version}`],
                ...(payload.model.providerId === undefined ? [] : [["Provider", payload.model.providerId]]),
                ...Object.entries(payload.model.parameters).map(([name, value]) => [name, String(value)])
            ]);
            panelBody.append(element("h3", undefined, "Prompt"));
            if ("withheld" in payload.model.prompt)
                panelBody.append(note(payload.model.prompt.withheld));
            else {
                panelBody.append(table([["Digest", payload.model.prompt.digest]]));
                panelBody.append(element("pre", "pipeline-details-prompt", payload.model.prompt.systemPrompt));
            }
        }
        if (payload.implementation !== undefined) {
            section("Implementation", [
                ["Body", `${payload.implementation.body.module} · ${payload.implementation.body.symbol}`],
                ["Port", `${payload.implementation.port.module} · ${payload.implementation.port.symbol}`],
                ...(payload.implementation.dispatch === undefined ? [] : [["Dispatch", payload.implementation.dispatch]])
            ]);
        }
    }
    function focusNode(nodeId) {
        if (nodeId === null)
            return;
        const node = Array.from(canvas.querySelectorAll("[data-diagram-node]"))
            .find((candidate) => candidate.getAttribute("data-diagram-node") === nodeId);
        node?.focus();
    }
    function closePanel() {
        if (destroyed || !ready)
            return;
        const previous = selected;
        clearDiagramNodeSelection(canvas);
        focusNode(previous);
    }
    function panelKeydown(event) {
        if (event.key !== "Escape")
            return;
        event.preventDefault();
        event.stopPropagation();
        closePanel();
    }
    function preserveMouseTarget(event) {
        const pointer = event;
        if (pointer.pointerType !== "mouse" || pointer.button !== 0)
            return;
        // graphpaper 0.5.0 captures every press on the SVG for panning. Chromium
        // then retargets the click to that SVG, losing the node. Mouse dragging
        // already uses the renderer's window listeners; release only node presses
        // so its existing click handler receives the original target. Touch/pen
        // capture and background panning remain renderer-owned.
        let target = pointer.target;
        while (target !== null && target !== canvas) {
            const nodeId = target.getAttribute?.("data-diagram-node");
            if (nodeId !== null && nodeId !== undefined) {
                const svg = canvas.querySelector("svg");
                if (svg?.hasPointerCapture(pointer.pointerId))
                    svg.releasePointerCapture(pointer.pointerId);
                return;
            }
            target = target.parentElement;
        }
    }
    function rememberSelection(nodeId) {
        if (hashParam === null || suppressUrl)
            return;
        try {
            const url = new URL(window.location.href);
            const params = new URLSearchParams(url.hash.slice(1));
            if (nodeId === null)
                params.delete(hashParam);
            else
                params.set(hashParam, nodeId);
            url.hash = params.toString();
            if (url.href !== window.location.href)
                window.history.replaceState(window.history.state, "", url.href);
        }
        catch { /* A restrictive history policy must not disable local selection. */ }
    }
    async function loadDetails(node, request) {
        try {
            const payload = await details(node.id);
            if (destroyed || request !== epoch || selected !== node.id)
                return;
            if (payload === undefined)
                throw new Error("details unavailable");
            const checked = validateNodeDetails(payload, graph, node.id);
            if (checked.sealed.kind !== node.type)
                throw new Error("node details kind mismatch");
            if (destroyed || request !== epoch || selected !== node.id)
                return;
            renderDetails(checked);
        }
        catch {
            if (!destroyed && request === epoch && selected === node.id)
                panelBody.replaceChildren(note(unavailable));
        }
    }
    function picked(selection) {
        if (!ready || destroyed)
            return;
        // graphpaper may normalize a node into its own mutable record. Only the
        // validated detached snapshot can cross our callback/details boundary.
        const node = selection.nodeId === null ? null : byId.get(selection.nodeId);
        if (node === undefined)
            return;
        selected = selection.nodeId;
        epoch += 1;
        rememberSelection(selected);
        if (panel !== undefined) {
            panel.hidden = selected === null;
            panelBody.replaceChildren();
            panelTitle.textContent = node?.title ?? "Node details";
            if (node !== null) {
                if (node.metadata?.nodeId === selected) {
                    panelBody.append(note("Loading details…"));
                    void loadDetails(node, epoch);
                }
                else {
                    // Endpoint and terminal words already belong to the model. They have
                    // no sealed engine node, so they do not invoke the node-details seam.
                    if (node.description !== undefined)
                        panelBody.append(element("p", undefined, node.description));
                    if (node.rows !== undefined)
                        panelBody.append(table(node.rows.map((row) => [row.label, row.value ?? ""])));
                }
                if (selection.source === "keyboard")
                    panel.focus();
            }
        }
        try {
            onSelect?.(ownFrozen({ nodeId: selected, node, source: selection.source }));
        }
        catch { /* Consumer callbacks cannot strand selection or pending detail state. */ }
    }
    function followHash() {
        if (!ready || destroyed || hashParam === null)
            return;
        try {
            const values = new URLSearchParams(window.location.hash.slice(1)).getAll(hashParam);
            const nodeId = values.length === 1 && byId.has(values[0]) ? values[0] : null;
            suppressUrl = true;
            selectDiagramNode(canvas, nodeId);
        }
        finally {
            suppressUrl = false;
        }
    }
    function destroy() {
        if (destroyed)
            return;
        const refocus = panel?.contains(document.activeElement) === true ? selected : null;
        destroyed = true;
        ready = false;
        epoch += 1;
        for (const element of claimed)
            mounted.delete(element);
        window.removeEventListener("hashchange", followHash);
        canvas.removeEventListener("pointerdown", preserveMouseTarget);
        closeButton?.removeEventListener("click", closePanel);
        panel?.removeEventListener("keydown", panelKeydown);
        cleanupHydratedDiagram(canvas);
        panel?.remove();
        releaseHost?.();
        canvas.replaceChildren(...originalChildren);
        if (originalHydrated === null)
            container.removeAttribute("data-pipeline-hydrated");
        else
            container.setAttribute("data-pipeline-hydrated", originalHydrated);
        if (addedClass)
            container.classList.remove("pipeline-viewer");
        focusNode(refocus);
    }
    for (const element of claimed)
        mounted.add(element);
    if (addedClass)
        container.classList.add("pipeline-viewer");
    try {
        await hydrateDiagram(canvas, model, {
            ...staticViewerRenderOptions(model),
            markerId: `pipeline-viewer-arrow-${++nextMarkerId}`,
            ...(Object.hasOwn(raw, "legendVisible") ? { legendVisible: raw.legendVisible } : {}),
            ...(layoutEngine === undefined ? {} : { layoutEngine }),
            onNodeSelect: picked
        });
        if (!canvas.isConnected || !selectDiagramNode(canvas, null, { notify: false }))
            throw new Error("pipeline hydration did not attach selection");
        canvas.addEventListener("pointerdown", preserveMouseTarget);
        if (details !== undefined) {
            const host = container.parentElement;
            if (host === null)
                throw new Error("pipeline details require a containing element");
            releaseHost = acquireHost(host);
            panel = element("aside", "pipeline-details");
            panel.hidden = true;
            panel.tabIndex = -1;
            panel.setAttribute("role", "complementary");
            panel.setAttribute("aria-label", "Node details");
            panelTitle = element("h2", "pipeline-details-title", "Node details");
            closeButton = element("button", "pipeline-details-close", "×");
            closeButton.type = "button";
            closeButton.setAttribute("aria-label", "Close node details");
            const header = element("header", "pipeline-details-header");
            header.append(panelTitle, closeButton);
            panelBody = element("div", "pipeline-details-body");
            panelBody.setAttribute("aria-live", "polite");
            panel.append(header, panelBody);
            host.insertBefore(panel, container.nextSibling);
            closeButton.addEventListener("click", closePanel);
            panel.addEventListener("keydown", panelKeydown);
        }
        ready = true;
        container.setAttribute("data-pipeline-hydrated", "graphpaper");
        if (hashParam !== null) {
            window.addEventListener("hashchange", followHash);
            followHash();
        }
    }
    catch (error) {
        destroy();
        throw error;
    }
    return ownFrozen({
        select: (nodeId) => !destroyed && ready && (nodeId === null || typeof nodeId === "string" && byId.has(nodeId))
            ? selectDiagramNode(canvas, nodeId) : false,
        destroy
    });
}
