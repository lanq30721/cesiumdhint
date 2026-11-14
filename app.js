const $ = id => document.getElementById(id);
const staticSite = document.documentElement.dataset.runtime === "static";
const staticPoemFiles = { "李白": "libai", "杜甫": "dufu", "孟浩然": "menghaoran" };
const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const limit = 12;
let data;
let selectedPair;
let selectedMatch;
let readingVersion = 0;
let generating = false;
const poemCache = new Map();
const scoreDistributions = new Map();
const scorePlot = { left: 44, right: 481, top: 28, bottom: 312, min: 7000, max: 10000 };
let paintHeatSelection;

async function request(url, options) {
  const response = await fetch(url, options);
  let json;
  try {
    if (response.headers.get("Content-Type")?.startsWith("text/event-stream")) {
      const body = await response.text();
      const event = body.split("\n").find(line => line.startsWith("data: "));
      if (!event) throw new Error("Missing generation result");
      json = JSON.parse(event.slice(6));
    } else {
      json = await response.json();
    }
  } catch {
    throw new Error("连接中断或服务暂时不可用，请稍后重试。");
  }
  if (!response.ok || json.error) throw new Error(json.error || `请求失败（${response.status}）`);
  return json;
}

function svgNode(name, attrs = {}, content = "") {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (content) node.textContent = content;
  return node;
}

function chart(id, width, height, label) {
  const root = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, "aria-label": label });
  $(id).replaceChildren(root);
  return root;
}

function text(parent, x, y, label, attrs = {}) {
  parent.append(svgNode("text", { x, y, ...attrs }, label));
}

function line(parent, x1, y1, x2, y2, attrs = {}) {
  parent.append(svgNode("line", { x1, y1, x2, y2, ...attrs }));
}

function interactive(node, label, action) {
  node.setAttribute("tabindex", "0");
  node.setAttribute("role", "button");
  node.setAttribute("aria-label", label);
  node.prepend(svgNode("title", {}, label));
  node.addEventListener("click", action);
  node.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      action();
    }
  });
}

function quantile(sorted, fraction) {
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower);
}

function renderBoxes() {
  const root = chart("boxes", 900, 248, "李白—杜甫与李白—孟浩然匹配分数箱线图");
  const x = score => 165 + (score - 7000) * 692 / 3000;
  const defs = svgNode("defs");
  for (const [index, color] of ["var(--blue)", "var(--rose)"].entries()) {
    const weave = svgNode("linearGradient", { id: `box-silk-${index}`, x2: "20%", y2: "100%" });
    for (const [offset, opacity] of [[0, .13], [.33, .57], [.63, .23], [1, .07]]) {
      weave.append(svgNode("stop", { offset, "stop-color": color, "stop-opacity": opacity }));
    }
    defs.append(weave);
  }
  root.append(defs);
  const gusts = svgNode("g", { class: "box-gusts", "aria-hidden": "true" });
  for (const d of [
    "M141 89 C265 24 425 28 545 62 S732 102 887 24",
    "M191 105 C323 40 451 49 570 80 S756 97 900 52",
    "M153 182 C293 110 425 118 555 158 S740 193 875 121",
    "M193 191 C311 136 437 137 563 172 S748 196 897 146",
  ]) gusts.append(svgNode("path", { d }));
  root.append(gusts);
  for (let score = 7000; score <= 10000; score += 500) {
    line(root, x(score), 199, x(score), 207, { class: "gridline" });
    text(root, x(score), 224, score, { "text-anchor": "middle", class: "muted" });
  }
  for (const [index, group] of Object.values(data.groups).entries()) {
    const scores = group.matches.map(row => row[4]).sort((a, b) => a - b);
    const [q1, median, q3] = [.25, .5, .75].map(f => quantile(scores, f));
    const fence = 1.5 * (q3 - q1);
    const low = scores.find(score => score >= q1 - fence);
    const high = scores.findLast(score => score <= q3 + fence);
    const y = 68 + index * 96;
    const series = index ? "var(--rose)" : "var(--blue)";
    const marks = svgNode("g");
    marks.append(svgNode("title", {}, `样本 ${number.format(scores.length)}，下四分位 ${q1}，中位数 ${median}，上四分位 ${q3}，须线 ${low}–${high}`));
    text(root, 13, y - 4, `李白 · ${group.poet}`, { class: "box-poets" });
    text(root, 13, y + 17, `${number.format(scores.length)} 条`, { class: "muted" });
    marks.append(svgNode("path", {
      d: `M${x(low)},${y} Q${(x(low) + x(q1)) / 2},${y + 6} ${x(q1)},${y} M${x(q3)},${y} C${x(q3) + 29},${y - 23} ${x(high) - 27},${y + 18} ${x(high)},${y}`,
      fill: "none", stroke: series, "stroke-width": 1.3,
    }));
    for (const cap of [low, high]) line(marks, x(cap), y - 6, x(cap), y + 6, { stroke: series });
    const left = x(q1), right = x(q3);
    const span = right - left;
    const fold = (x, height) => height * Math.sin((x - left) / span * Math.PI * 2) - 5 * (x - left) / span;
    const ribbon = `M${left},${y - 17} C${left + span * .27},${y + 16} ${right - span * .32},${y - 49} ${right},${y - 24}
      Q${right - span * .09},${y - 9} ${right},${y + 4} C${right - span * .32},${y - 12} ${left + span * .27},${y + 33} ${left},${y + 17}Z`;
    marks.append(svgNode("path", { d: ribbon, fill: `url(#box-silk-${index})`, stroke: series, class: "wind-ribbon" }));
    for (const offset of [-9, -4, 3, 9]) {
      const silk = `M${left},${y + offset} C${left + span * .27},${y + offset + 24} ${right - span * .32},${y + offset - 29} ${right},${y + offset - 5}`;
      marks.append(svgNode("path", { d: silk, fill: "none", stroke: series, "stroke-opacity": .55, "stroke-width": .8 }));
    }
    const medianY = y + fold(x(median), 5);
    line(marks, x(median), medianY - 14, x(median), medianY + 12, { class: "box-median" });
    for (const score of new Set(scores.filter(s => s < low || s > high))) {
      marks.append(svgNode("circle", { cx: x(score), cy: y, r: 2.1, stroke: series, "stroke-opacity": .38, fill: "none" }));
    }
    root.append(marks);
    text(root, x(median), y - 27, number.format(median), { "text-anchor": "middle", class: "box-score" });
  }
}

function aggregate(matches, minimum) {
  const pairs = new Map();
  for (const match of matches) {
    const [left, , right, , score] = match;
    if (score < minimum) continue;
    const key = `${left}/${right}`;
    if (!pairs.has(key)) pairs.set(key, { key, left, right, max: score, matches: [] });
    const pair = pairs.get(key);
    pair.max = Math.max(pair.max, score);
    pair.matches.push(match);
  }
  return [...pairs.values()].sort((a, b) => b.max - a.max || b.matches.length - a.matches.length || a.key.localeCompare(b.key));
}

function currentGroup() {
  return data.groups[$("group").value];
}

function title(name, id) {
  return data.titles[name][id];
}

function pairLabel(pair, poet) {
  return `李白《${title("李白", pair.left)}》 × ${poet}《${title(poet, pair.right)}》，最高 ${pair.max}，${pair.matches.length} 条`;
}

function short(label, length) {
  return label.length > length ? label.slice(0, length - 1) + "…" : label;
}

function showRelations() {
  const group = currentGroup();
  const minimum = Number($("threshold").value);
  $("cut").value = minimum;
  const pairs = aggregate(group.matches, minimum);
  const left = [...new Set(pairs.map(pair => pair.left))].slice(0, limit);
  const right = [...new Set(pairs.map(pair => pair.right))].slice(0, limit);
  const shown = pairs.filter(pair => left.includes(pair.left) && right.includes(pair.right));
  const next = shown.find(pair => pair.key === selectedPair?.key) || shown[0];
  if (next) {
    selectPair(next);
  } else {
    selectedPair = null;
    selectedMatch = null;
    readingVersion += 1;
    $("match").replaceChildren();
    $("reading").replaceChildren();
    $("reading").textContent = "当前分数门槛下没有匹配。";
    $("seed").textContent = "请降低最低分数以选择诗句。";
    updateSubmit();
  }
  drawHeat(group.poet, left, right, shown, minimum);
  drawNetwork(group.poet, left, right, shown);
  drawClusters(group.poet, left, pairs, shown);
  updateRetention(minimum);
  updateSubmit();
}

function updateSelectionMarks() {
  if (selectedPair) {
    const picker = $("heat-pair");
    picker.querySelector("[data-outside-grid]")?.remove();
    const label = pairLabel(selectedPair, currentGroup().poet);
    if (![...picker.options].some(option => option.value === selectedPair.key)) {
      const option = new Option(label, selectedPair.key);
      option.dataset.outsideGrid = "";
      picker.prepend(option);
    }
    picker.value = selectedPair.key;
    const { left, right, max, matches } = selectedPair;
    const poet = currentGroup().poet;
    const titles = [["李白", left], [poet, right]].map(([name, id]) => {
      const entry = document.createElement("p");
      entry.className = "pair-work";
      const seal = document.createElement("span");
      seal.className = "poet-seal";
      seal.textContent = name;
      const poemTitle = document.createElement("span");
      poemTitle.textContent = `《${title(name, id)}》`;
      entry.append(seal, poemTitle);
      return entry;
    });
    const stats = document.createElement("p");
    stats.className = "pair-score";
    stats.textContent = `最高 ${number.format(max)} · ${number.format(matches.length)} 条句对`;
    $("heat-selected").replaceChildren(...titles, stats);
    $("heat-read-link").hidden = false;
  }
  for (const mark of document.querySelectorAll("[data-pair]")) {
    const active = mark.dataset.pair === selectedPair?.key;
    mark.setAttribute("aria-pressed", String(active));
    mark.classList.toggle("chosen", active);
  }
  for (const mark of document.querySelectorAll("[data-wind-pair]")) {
    mark.classList.toggle("chosen", mark.dataset.windPair === selectedPair?.key);
  }
  const network = $("network");
  const labels = network.querySelectorAll(".network-work");
  for (const label of labels) {
    label.classList.toggle("chosen", label.dataset.work === selectedPair?.[label.dataset.side]);
  }
  sailSelectedPair(network);
  for (const mark of document.querySelectorAll("[data-cluster-leaves]")) {
    const active = mark.dataset.clusterLeaves.split(",").includes(selectedPair?.left);
    mark.classList.toggle("chosen", active);
    if (mark.getAttribute("role") === "button") mark.setAttribute("aria-pressed", String(active));
  }
  paintHeatSelection?.();
}

function drawHeat(poet, left, right, shown, minimum) {
  const useCount = $("metric").value === "count";
  const low = useCount ? 1 : minimum;
  const high = useCount ? Math.max(1, ...shown.map(pair => pair.matches.length)) : 10000;
  const color = value => {
    const fraction = high === low ? .65 : (value - low) / (high - low);
    return `hsl(${198 + 13 * fraction} 39% ${73 - 38 * fraction}%)`;
  };
  const values = [0, .25, .5, .75, 1].map(ratio => low + (high - low) * ratio);
  const ramp = document.createElement("span");
  ramp.className = "heat-ramp";
  ramp.style.background = `linear-gradient(90deg, ${values.map(color).join(", ")})`;
  ramp.setAttribute("aria-hidden", "true");
  $("heat-scale").replaceChildren(useCount ? "匹配句对数" : "最高分数", ramp, high === low ? String(low) : `${low}–${high}`);

  const picker = $("heat-pair");
  picker.replaceChildren(...shown.map(pair => new Option(pairLabel(pair, poet), pair.key)));
  picker.disabled = shown.length === 0;
  picker.onchange = () => {
    const pair = shown.find(candidate => candidate.key === picker.value);
    if (pair) selectPair(pair);
  };
  $("heat-read-link").hidden = shown.length === 0;
  if (!shown.length) {
    $("heat-selected").textContent = "当前门槛下没有匹配。";
  }

  const byKey = new Map(shown.map(pair => [pair.key, pair]));
  const cells = [];
  for (const [row, id] of left.entries()) {
    const center = (row + .5) / left.length;
    const reach = Math.min(.39 / left.length, .039);
    const band = Array.from({ length: 9 }, (_, n) => streamEdge(center + reach * (n / 4 - 1)));
    const returning = band.slice().reverse();
    for (const [column, other] of right.entries()) {
      const pair = byKey.get(`${id}/${other}`);
      if (!pair) continue;
      const middle = (column + .5) / right.length;
      const halfWidth = Math.min(.47 / right.length, .052);
      const shape = new Path2D();
      const [firstX, firstY] = streamPoint(band[0], middle);
      shape.moveTo(firstX, firstY);
      for (const [n, edge] of band.entries()) {
        shape.lineTo(...streamPoint(edge, middle + halfWidth * Math.sin(Math.PI * n / (band.length - 1))));
      }
      for (const [n, edge] of returning.entries()) {
        shape.lineTo(...streamPoint(edge, middle - halfWidth * Math.sin(Math.PI * n / (band.length - 1))));
      }
      shape.closePath();
      const glint = new Path2D();
      glint.moveTo(...streamPoint(band[2], middle - halfWidth * .42));
      glint.quadraticCurveTo(...streamPoint(band[4], middle - halfWidth * .77),
                            ...streamPoint(band[6], middle - halfWidth * .28));
      cells.push({ pair, shape, glint, fill: color(useCount ? pair.matches.length : pair.max) });
    }
  }

  const canvas = $("heat-canvas");
  const ctx = canvas.getContext("2d");
  const hint = $("heat-hover");
  let hovered;
  hint.hidden = true;
  paintHeatSelection = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const cell of cells) {
      ctx.fillStyle = cell.fill;
      ctx.globalAlpha = .88;
      ctx.fill(cell.shape);
      ctx.globalAlpha = 1;
      const active = cell.pair.key === selectedPair?.key;
      ctx.lineWidth = active || cell === hovered ? 3 : 1.15;
      ctx.strokeStyle = active ? "#a34d37" : "#f7f4e9";
      ctx.stroke(cell.shape);
      ctx.lineWidth = .85;
      ctx.strokeStyle = "#fffbec99";
      ctx.stroke(cell.glint);
    }
  };
  function cellAt(event) {
    const { left, top, width, height } = canvas.getBoundingClientRect();
    const x = (event.clientX - left) * canvas.width / width;
    const y = (event.clientY - top) * canvas.height / height;
    return cells.find(cell => ctx.isPointInPath(cell.shape, x, y));
  }
  canvas.onpointermove = event => {
    const cell = cellAt(event);
    if (cell === hovered) return;
    hovered = cell;
    canvas.style.cursor = hovered ? "pointer" : "";
    hint.hidden = !hovered;
    hint.textContent = hovered ? pairLabel(hovered.pair, poet) : "";
    paintHeatSelection();
  };
  canvas.onpointerleave = () => {
    hovered = undefined;
    hint.hidden = true;
    canvas.style.cursor = "";
    paintHeatSelection();
  };
  canvas.onclick = event => {
    const cell = cellAt(event);
    if (cell) selectPair(cell.pair);
  };
  updateSelectionMarks();
}

function streamPoint({ x, y, span, slope }, fraction) {
  const across = (fraction - .5) * span;
  return [x + across, y - across * slope * .12];
}

// Each guide point is the center and width of the painted stream at that height.
const streamGuides = [
  [378, 616, 106], [456, 690, 207], [528, 587, 250], [604, 426, 278],
  [687, 309, 290], [766, 305, 251], [840, 372, 247], [914, 535, 270],
  [981, 605, 173], [1036, 567, 103],
];

function streamEdge(t) {
  const position = t * (streamGuides.length - 1);
  const index = Math.min(streamGuides.length - 2, Math.floor(position));
  const previous = streamGuides[Math.max(0, index - 1)];
  const start = streamGuides[index];
  const end = streamGuides[index + 1];
  const following = streamGuides[Math.min(streamGuides.length - 1, index + 2)];
  const u = position - index;
  const [vertical, horizontal, width] = start.map((value, n) => {
    const entrySlope = (end[n] - previous[n]) / 2;
    const exitSlope = (following[n] - value) / 2;
    const coordinate = value + (end[n] - value) * u * u * (3 - 2 * u)
      + u * (1 - u) * (entrySlope * (1 - u) - exitSlope * u);
    const derivative = 6 * u * (1 - u) * (end[n] - value)
      + (1 - u) * (1 - 3 * u) * entrySlope + u * (3 * u - 2) * exitSlope;
    return { coordinate, derivative };
  });
  return { x: horizontal.coordinate, y: vertical.coordinate, span: width.coordinate,
    slope: horizontal.derivative / vertical.derivative };
}

function textLabel(parent, x, y, label, full, attrs) {
  const node = svgNode("text", { x, y, ...attrs }, label);
  node.append(svgNode("title", {}, full));
  parent.append(node);
  return node;
}

function networkBrush(root) {
  const defs = svgNode("defs");
  const filter = svgNode("filter", { id: "network-brush", x: "-15%", y: "-35%", width: "130%", height: "170%" });
  filter.append(
    svgNode("feTurbulence", { type: "fractalNoise", baseFrequency: ".07 .6", numOctaves: 2, seed: 11 }),
    svgNode("feDisplacementMap", { in: "SourceGraphic", scale: 2.8, xChannelSelector: "R", yChannelSelector: "G" }),
  );
  defs.append(filter);
  root.append(defs);
}

function drawNetwork(poet, left, right, shown) {
  const atCottage = poet === "杜甫";
  $("network-title").textContent = atCottage ? "乘舟访草堂" : "隔水寻诗";
  const root = chart("network", 1000, 448, `李白与${poet}作品关系网络`);
  const a = 246, b = 754;
  const y = index => index === 0 ? 79 : 128 + (index - 1) * 24;
  drawRiver(root);
  networkBrush(root);
  text(root, a, 24, "李白", { "text-anchor": "middle", class: "network-author" });
  text(root, b, 24, poet, { "text-anchor": "middle", class: "network-author" });
  const edges = svgNode("g");
  const highlights = svgNode("g", { class: "wind-highlights", "aria-hidden": "true" });
  root.append(edges, highlights);
  for (const pair of shown) {
    const y1 = y(left.indexOf(pair.left)), y2 = y(right.indexOf(pair.right));
    const rise = 16 + Math.abs(y1 - y2) * .035;
    const d = `M${a},${y1} C324,${y1} 354,${y1 - rise} 411,${y1 - rise}
      S508,${y2 + rise} 571,${y2 + rise} S670,${y2 - 8} ${b},${y2}`;
    const mark = svgNode("g", { class: "edge" });
    mark.dataset.pair = pair.key;
    const width = 1.4 + Math.min(9, pair.matches.length) * .65;
    mark.append(svgNode("path", { d, fill: "none", stroke: "transparent", "stroke-width": 8 }));
    mark.append(svgNode("path", { d, class: "wind-wash", "stroke-width": width + 3.5 }));
    mark.append(svgNode("path", { d, class: "visible-edge", "stroke-width": width }));
    const highlight = svgNode("path", { d, class: "wind-selected", "stroke-width": width });
    highlight.dataset.windPair = pair.key;
    highlights.append(highlight);
    interactive(mark, pairLabel(pair, poet), () => selectPair(pair));
    edges.append(mark);
  }
  for (const [ids, x, author, side, anchor, offset, fill] of [
    [left, a, "李白", "left", "end", -9, "var(--blue)"], [right, b, poet, "right", "start", 9, "var(--rose)"],
  ]) {
    for (const [index, id] of ids.entries()) {
      const nodeY = y(index);
      const name = title(author, id);
      const node = svgNode("g", { class: "network-work", "data-work": id, "data-side": side });
      node.append(svgNode("title", {}, name));
      if (index === 0) {
        const portrait = side === "left" ? 0 : atCottage ? 1 : 5;
        node.append(riverSprite(portrait, x - 36, nodeY - 39, 72));
      } else {
        node.append(svgNode("circle", { cx: x, cy: nodeY, r: 2.5, fill }));
      }
      text(node, x + (index === 0 ? Math.sign(offset) * 43 : offset), nodeY + 4, short(name, 12), { "text-anchor": anchor, class: "axis-label" });
      root.append(node);
    }
  }
  root.append(riverSprite(2, a - 28, 386, 56));
  if (atCottage) root.append(riverSprite(4, b - 46, 364, 92));
  root.append(svgNode("g", { class: "river-boat", "aria-hidden": "true" }));
  updateSelectionMarks();
}

function riverSprite(index, x, y, size) {
  const cell = 240;
  const left = (index % 3) * cell;
  const top = Math.floor(index / 3) * cell;
  const sprite = svgNode("svg", { x, y, width: size, height: size, viewBox: `${left} ${top} ${cell} ${cell}`, class: "river-sprite", "aria-hidden": "true" });
  sprite.append(svgNode("image", { href: "./river-characters.webp", width: cell * 3, height: cell * 2 }));
  return sprite;
}

function drawRiver(root) {
  const defs = svgNode("defs");
  const water = svgNode("radialGradient", { id: "river-water" });
  water.append(svgNode("stop", { offset: "0%", "stop-color": "#568fa8", "stop-opacity": .25 }),
               svgNode("stop", { offset: "100%", "stop-color": "#568fa8", "stop-opacity": 0 }));
  defs.append(water);
  root.append(defs);
  const wash = svgNode("g", { class: "river-scenery", "aria-hidden": "true" });
  wash.append(svgNode("ellipse", { cx: 500, cy: 228, rx: 370, ry: 221, fill: "url(#river-water)" }));
  for (const d of [
    "M208 14 Q234 75 221 142 T226 282 T206 423",
    "M794 13 Q765 87 788 164 T777 301 T800 432",
    "M274 106 C341 130 397 106 447 118 S567 142 610 116",
    "M360 278 C420 298 496 272 541 288 S663 308 709 286",
    "M291 383 C369 400 463 373 530 389 S654 403 724 379",
  ]) wash.append(svgNode("path", { d }));
  root.append(wash);
}

function sailSelectedPair(network) {
  const boat = network.querySelector(".river-boat");
  const route = network.querySelector(".wind-selected.chosen");
  if (!boat) return;
  if (!route) {
    boat.replaceChildren();
    delete boat.dataset.route;
    return;
  }
  if (boat.dataset.route === route.dataset.windPair) return;
  boat.dataset.route = route.dataset.windPair;
  const position = route.getPointAtLength(route.getTotalLength() * .89);
  boat.setAttribute("transform", `translate(${position.x} ${position.y})`);
  boat.replaceChildren(riverSprite(3, -25, -34, 50));
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const sail = svgNode("animateMotion", {
      path: route.getAttribute("d"), keyPoints: ".1;.89", keyTimes: "0;1", calcMode: "linear",
      dur: "4.2s", begin: "indefinite", fill: "freeze",
    });
    boat.removeAttribute("transform");
    boat.append(sail);
    sail.beginElement();
  }
}

function plotX(score) {
  const { left, right, min, max } = scorePlot;
  return left + (score - min) * (right - left) / (max - min);
}

function plotY(share) {
  return scorePlot.bottom - share * (scorePlot.bottom - scorePlot.top);
}

function drawRetention() {
  const { left, right, top, bottom, min, max } = scorePlot;
  const root = chart("retention", 520, 390, "两组诗句匹配的分数门槛与保留比例");
  const defs = svgNode("defs");
  for (const [id, color] of [["du", "var(--blue)"], ["meng", "var(--rose)"]]) {
    const gradient = svgNode("linearGradient", { id: `wind-${id}`, x1: "0%", x2: "0%", y1: "0%", y2: "100%" });
    gradient.append(svgNode("stop", { offset: "0%", "stop-color": color, "stop-opacity": .16 }),
                    svgNode("stop", { offset: "100%", "stop-color": color, "stop-opacity": .015 }));
    defs.append(gradient);
  }
  root.append(defs);
  for (const share of [0, .25, .5, .75, 1]) {
    line(root, left, plotY(share), right, plotY(share), { class: "gridline" });
    text(root, left - 7, plotY(share) + 4, `${share * 100}%`, { "text-anchor": "end", class: "muted axis-label" });
  }
  for (let score = min; score <= max; score += 1000) {
    text(root, plotX(score), bottom + 23, score, { "text-anchor": "middle", class: "muted axis-label" });
  }
  text(root, right, bottom + 46, "最低匹配分数", { "text-anchor": "end", class: "muted axis-label" });
  for (const [id, group] of Object.entries(data.groups)) {
    const exact = new Map();
    for (const match of group.matches) exact.set(match[4], (exact.get(match[4]) || 0) + 1);
    const counts = [];
    let total = 0;
    for (let score = max; score >= min; score -= 1) {
      total += exact.get(score) || 0;
      counts[score - min] = total;
    }
    scoreDistributions.set(id, counts);
    let d = `M${left},${plotY(counts[0] / group.matches.length)}`;
    for (let score = min + 1; score <= max; score += 1) {
      const index = score - min;
      if (counts[index] !== counts[index - 1]) {
        d += `H${plotX(score).toFixed(2)}V${plotY(counts[index] / group.matches.length).toFixed(2)}`;
      }
    }
    d += `H${right}`;
    root.append(svgNode("path", { d: `${d}V${bottom}H${left}Z`, fill: `url(#wind-${id})` }));
    root.append(svgNode("path", { d, class: `retention-line retention-${id}` }));
  }
  root.append(svgNode("g", { id: "retention-cursor", "aria-hidden": "true" }));
  const hit = svgNode("rect", { x: left, y: top, width: right - left, height: bottom - top, fill: "transparent", class: "retention-hit" });
  hit.addEventListener("click", event => {
    const matrix = root.getScreenCTM();
    if (!matrix) return;
    const { x } = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    const input = $("threshold");
    input.value = Math.round(min + (x - left) * (max - min) / (right - left));
    showRelations();
  });
  root.append(hit);
}

function updateRetention(score) {
  const cursor = $("retention-cursor");
  const x = plotX(score);
  cursor.replaceChildren();
  line(cursor, x, scorePlot.top, x, scorePlot.bottom, { class: "retention-rule" });
  const labels = [];
  for (const [id, group] of Object.entries(data.groups)) {
    const count = scoreDistributions.get(id)[score - scorePlot.min];
    const share = count / group.matches.length;
    cursor.append(svgNode("circle", { cx: x, cy: plotY(share), r: 4, class: `retention-${id}` }));
    const label = document.createElement("span");
    label.className = `score-key score-key-${id}`;
    label.textContent = `李白 · ${group.poet} ${number.format(share * 100)}%（${number.format(count)} 条）`;
    labels.push(label);
  }
  $("retention-summary").replaceChildren(...labels);
}

function clusterWorks(ids, pairs) {
  const neighbors = new Map(ids.map(id => [id, new Set()]));
  for (const pair of pairs) neighbors.get(pair.left)?.add(pair.right);
  const similarity = new Map(ids.map(a => [a, new Map(ids.map(b => {
    const left = neighbors.get(a), right = neighbors.get(b);
    const shared = [...left].filter(id => right.has(id)).length;
    return [b, shared / (left.size + right.size - shared)];
  }))]));
  const groups = ids.map(id => ({ leaves: [id], distance: 0 }));
  while (groups.length > 1) {
    let best = 0;
    let merge;
    for (let i = 0; i < groups.length; i += 1) {
      for (let j = i + 1; j < groups.length; j += 1) {
        const a = groups[i], b = groups[j];
        let total = 0;
        for (const x of a.leaves) {
          for (const y of b.leaves) total += similarity.get(x).get(y);
        }
        const mean = total / (a.leaves.length * b.leaves.length);
        if (mean > best) {
          best = mean;
          merge = [i, j];
        }
      }
    }
    if (!merge) break;
    const [i, j] = merge;
    const children = [groups[i], groups[j]];
    groups.splice(j, 1);
    groups.splice(i, 1, { leaves: children.flatMap(child => child.leaves), distance: 1 - best, children });
  }
  return { groups, neighbors };
}

function drawClusters(poet, ids, pairs, shown) {
  const { groups, neighbors } = clusterWorks(ids, pairs);
  const isolated = groups.filter(group => group.leaves.length === 1).length;
  $("cluster-count").textContent = `${groups.length - isolated} 个多作品簇 · ${isolated} 首未合并`;
  const height = Math.max(116, 76 + ids.length * 30 + Math.max(0, groups.length - 1) * 7);
  const root = chart("cluster", 780, height, `李白作品按共同匹配的${poet}作品聚类`);
  const start = 290, end = 747;
  const x = distance => start + distance * (end - start);
  text(root, 12, 25, "李白作品", { class: "cluster-muted" });
  text(root, end, 25, "聚类距离", { "text-anchor": "end", class: "cluster-muted" });
  for (const tick of [0, .25, .5, .75, 1]) {
    line(root, x(tick), 54, x(tick), height - 12, { stroke: "#283249", "stroke-width": 1 });
    text(root, x(tick), 47, String(tick), { "text-anchor": "middle", class: "cluster-muted" });
  }
  let nextY = 76;
  const branches = svgNode("g");
  const leaves = svgNode("g");
  root.append(branches, leaves);

  function draw(node) {
    if (!node.children) {
      const [id] = node.leaves;
      const y = nextY;
      nextY += 30;
      const pair = shown.find(candidate => candidate.left === id) || pairs.find(candidate => candidate.left === id);
      const label = title("李白", id);
      const mark = svgNode("g", { class: "cluster-leaf" });
      mark.dataset.clusterLeaves = id;
      mark.append(svgNode("rect", { x: 0, y: y - 12, width: start + 10, height: 24, fill: "transparent" }));
      mark.append(svgNode("circle", { cx: start, cy: y, r: 4.5 }));
      text(mark, 12, y + 4, short(label, 17));
      text(mark, start - 17, y + 4, String(neighbors.get(id).size), { "text-anchor": "end", class: "cluster-muted" });
      interactive(mark, `李白《${label}》，匹配 ${neighbors.get(id).size} 首${poet}作品。查看相关诗句。`, () => selectPair(pair));
      leaves.append(mark);
      return y;
    }
    const [a, b] = node.children.map(draw);
    const y = (a + b) / 2;
    for (const [child, childY] of [[node.children[0], a], [node.children[1], b]]) {
      const x1 = x(child.distance), x2 = x(node.distance);
      const bend = x1 + (x2 - x1) * .56;
      const sweep = Math.min(14, (x2 - x1) * .09);
      const branch = svgNode("path", {
        d: `M${x1},${childY} C${bend},${childY - sweep} ${bend},${y + sweep} ${x2},${y}`,
        class: "cluster-branch", "stroke-width": 2 + child.leaves.length * 1.7, "stroke-linecap": "round",
      });
      branch.dataset.clusterLeaves = child.leaves.join(",");
      branch.append(svgNode("title", {}, `${child.leaves.length} 首作品 · 合并距离 ${number.format(node.distance)}`));
      branches.append(branch);
    }
    return y;
  }
  for (const group of groups) {
    draw(group);
    nextY += 7;
  }
  updateSelectionMarks();
}

function selectPair(pair) {
  selectedPair = pair;
  const group = currentGroup();
  const matches = [...pair.matches].sort((a, b) => b[4] - a[4] || a[1] - b[1] || a[3] - b[3]);
  const selected = matches.findIndex(match => match === selectedMatch);
  $("match").replaceChildren(...matches.map(([h, i, j, k, score], index) => new Option(`李白第 ${i + 1} 句 × ${group.poet}第 ${k + 1} 句 · ${score}`, index)));
  $("match").selectedIndex = Math.max(0, selected);
  $("match").onchange = () => showReading(matches[$("match").selectedIndex]);
  updateSelectionMarks();
  showReading(matches[$("match").selectedIndex]);
}

function poem(name, id) {
  if (staticSite) {
    if (!poemCache.has(name)) {
      poemCache.set(name, request(`./data/${staticPoemFiles[name]}.json`).catch(error => {
        poemCache.delete(name);
        throw error;
      }));
    }
    return poemCache.get(name).then(works => {
      if (!works[id]) throw new Error("没有查到原诗。");
      return works[id];
    });
  }
  const key = `${name}/${id}`;
  if (!poemCache.has(key)) {
    const query = new URLSearchParams({ poet: name, id });
    poemCache.set(key, request(`/api/poem?${query}`).catch(error => {
      poemCache.delete(key);
      throw error;
    }));
  }
  return poemCache.get(key);
}

async function showReading(match) {
  const version = ++readingVersion;
  selectedMatch = null;
  updateSubmit();
  $("reading").textContent = "读取原诗…";
  $("seed").textContent = "读取诗句素材…";
  const poet = currentGroup().poet;
  const [h, i, j, k] = match;
  const sources = [["李白", h, i], [poet, j, k]];
  try {
    const poems = await Promise.all(sources.map(([name, id]) => poem(name, id)));
    if (version !== readingVersion) return;
    const excerpts = [];
    $("reading").replaceChildren(...sources.map(([name, id, index], n) => {
      const article = document.createElement("article");
      article.className = "poem";
      const author = document.createElement("p");
      author.className = "poet-seal";
      author.textContent = name;
      const heading = document.createElement("h3");
      heading.textContent = `《${title(name, id)}》`;
      const lines = document.createElement("div");
      lines.className = "lines";
      for (const [position, content] of poems[n]) {
        const node = document.createElement(position === index ? "mark" : "span");
        node.textContent = content;
        lines.append(node, " ");
        if (position === index) {
          const quote = document.createElement("blockquote");
          quote.textContent = `「${content}」`;
          const citation = document.createElement("cite");
          citation.textContent = name;
          quote.append(citation);
          excerpts.push(quote);
        }
      }
      article.append(author, heading, lines);
      return article;
    }));
    for (const lines of $("reading").querySelectorAll(".lines")) {
      const mark = lines.querySelector("mark");
      lines.scrollTop = Math.max(0, mark.getBoundingClientRect().top - lines.getBoundingClientRect().top - 35);
    }
    $("seed").replaceChildren(...excerpts);
    selectedMatch = match;
    updateSubmit();
  } catch (error) {
    if (version !== readingVersion) return;
    $("reading").textContent = error.message;
    $("seed").textContent = "原诗读取失败。";
  }
}

function updateSubmit() {
  $("submit").disabled = !data?.generation || !selectedMatch || generating;
  $("next-pair").disabled = $("heat-pair").options.length < 2;
}

function fileData(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("读取参考图失败。"));
    reader.readAsDataURL(file);
  });
}

$("generate").addEventListener("submit", async event => {
  event.preventDefault();
  if ($("submit").disabled) return;
  const mode = $("mode").value;
  const body = { group: $("group").value, match: selectedMatch, mode, idea: $("idea").value };
  if (data.requiresPasscode) body.passcode = $("generation-passcode").value.trim();
  const seed = [...$("seed").querySelectorAll("blockquote")].map(quote => quote.firstChild.textContent).join(" × ");
  $("result").replaceChildren();
  $("generation-state").textContent = "正在生成…";
  generating = true;
  updateSubmit();
  try {
    const file = mode === "image" && $("reference").files[0];
    if (file) {
      if (file.size > 10 * 1024 * 1024) throw new Error("参考图大小需要在 10 MB 以内。");
      body.reference = await fileData(file);
    }
    const result = await request("/api/generate", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (result.text) {
      const output = document.createElement("pre");
      output.textContent = result.text;
      $("result").append(output);
    } else {
      const image = document.createElement("img");
      image.src = result.image;
      image.alt = "基于所选诗句生成的虚构插图";
      const link = document.createElement("a");
      link.href = result.image;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "打开原图（链接有效期 24 小时）";
      $("result").append(image, link);
    }
    $("generation-state").textContent = `AI 生成 · 虚构二创 · ${seed}`;
  } catch (error) {
    $("generation-state").textContent = error.message;
  } finally {
    generating = false;
    updateSubmit();
  }
});

async function init() {
  try {
    data = await request(staticSite ? "./data/matches.json" : "/api/data");
    if (staticSite) {
      $("create").hidden = true;
      document.querySelector(".nav-create").hidden = true;
      const action = document.querySelector(".hero-copy .action");
      action.href = "#relations";
      action.textContent = "查看作品图谱 ↓";
    }
    $("startup").hidden = true;
    $("workspace").hidden = false;
    $("api-status").hidden = data.generation;
    $("api-status").textContent = "本站暂未启用二创生成";
    $("passcode-field").hidden = !data.requiresPasscode;
    $("generation-passcode").required = Boolean(data.requiresPasscode);
    $("mode").onchange = () => { $("upload").hidden = $("mode").value !== "image"; };
    $("group").onchange = () => {
      $("create-group").value = $("group").value;
      selectedPair = null;
      selectedMatch = null;
      showRelations();
    };
    $("create-group").onchange = () => {
      $("group").value = $("create-group").value;
      $("group").onchange();
    };
    $("next-pair").onclick = () => {
      const picker = $("heat-pair");
      if (picker.options.length < 2) return;
      picker.selectedIndex = (picker.selectedIndex + 1) % picker.options.length;
      picker.onchange();
    };
    for (const button of document.querySelectorAll("[data-idea]")) {
      button.onclick = () => {
        $("idea").value = button.dataset.idea;
        $("idea").focus();
      };
    }
    $("threshold").oninput = showRelations;
    $("metric").onchange = showRelations;
    renderBoxes();
    drawRetention();
    showRelations();
  } catch (error) {
    $("startup").hidden = false;
    $("startup").textContent = `数据读取失败：${error.message}`;
  }
}
init();
