import { createHash } from "node:crypto";

import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";

import type { MapNode, MapView } from "../../../application/campaign/views/map-view.js";
import { fontFamily } from "../canvas/card-font.js";

// The party's map as a picture, drawn locally from the map view: no model and no
// network. Visited places are named boxes, places the party only knows a way to are
// dashed "???" boxes, a dead end is struck with a bar, a one-way exit is an arrow with
// a break in it. The picture is only redrawn when the map changes, so editing the
// party card for anything else re-sends the same few kilobytes.

export interface MapImage {
  readonly name: string;
  readonly bytes: Buffer;
}

export interface MapLabels {
  readonly unknown: string;
  readonly here: string;
  readonly deadEnd: string;
  readonly locked: string;
}

const boxWidth = 168;
const boxHeight = 52;
const gapX = 56;
const gapY = 22;
const margin = 20;

const colours = {
  background: "#1e2124",
  visited: "#2f3b4a",
  visitedLine: "#7f95ad",
  current: "#2d6a4f",
  currentLine: "#52d18c",
  unknown: "#26292d",
  unknownLine: "#6c7178",
  text: "#eef1f4",
  muted: "#9aa1a9",
  edge: "#9aa1a9",
  deadEnd: "#e0775f",
} as const;

export function renderMapImage(view: MapView, labels: MapLabels): MapImage | undefined {
  if (view.nodes.length === 0) return undefined;
  const columns = Math.max(...view.nodes.map((node) => node.column)) + 1;
  const rows = Math.max(...view.nodes.map((node) => node.row)) + 1;
  const width = margin * 2 + columns * boxWidth + (columns - 1) * gapX;
  const height = margin * 2 + rows * boxHeight + (rows - 1) * gapY;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = colours.background;
  context.fillRect(0, 0, width, height);

  const place = (node: MapNode): { readonly x: number; readonly y: number } => ({
    x: margin + node.column * (boxWidth + gapX),
    // A column with fewer places than the tallest one is centred against it.
    y: margin + node.row * (boxHeight + gapY) + ((rows - view.nodes.filter((other) => other.column === node.column).length) * (boxHeight + gapY)) / 2,
  });
  const byId = new Map(view.nodes.map((node) => [node.id, node]));

  for (const edge of view.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (from !== undefined && to !== undefined) drawEdge(context, place(from), place(to), edge.oneWay);
  }
  for (const node of view.nodes) drawNode(context, node, place(node), labels);

  const bytes = canvas.toBuffer("image/png");
  return { name: `map-${createHash("sha1").update(bytes).digest("hex").slice(0, 12)}.png`, bytes };
}

function drawEdge(context: SKRSContext2D, from: { x: number; y: number }, to: { x: number; y: number }, oneWay: boolean): void {
  const forward = to.x > from.x;
  const startX = forward ? from.x + boxWidth : to.x < from.x ? from.x : from.x + boxWidth / 2;
  const endX = forward ? to.x : to.x < from.x ? to.x + boxWidth : to.x + boxWidth / 2;
  const startY = from.y + boxHeight / 2;
  const endY = to.y + boxHeight / 2;
  context.strokeStyle = colours.edge;
  context.fillStyle = colours.edge;
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(startX, startY);
  const middle = (startX + endX) / 2;
  context.bezierCurveTo(middle, startY, middle, endY, endX, endY);
  context.stroke();
  // An arrow head at the destination.
  const direction = endX >= startX ? 1 : -1;
  context.beginPath();
  context.moveTo(endX, endY);
  context.lineTo(endX - 9 * direction, endY - 5);
  context.lineTo(endX - 9 * direction, endY + 5);
  context.closePath();
  context.fill();
  // A one-way exit has a bar across it: no way back is listed.
  if (oneWay) {
    context.strokeStyle = colours.deadEnd;
    context.lineWidth = 3;
    context.beginPath();
    context.moveTo(middle, (startY + endY) / 2 - 8);
    context.lineTo(middle, (startY + endY) / 2 + 8);
    context.stroke();
  }
}

function drawNode(context: SKRSContext2D, node: MapNode, at: { x: number; y: number }, labels: MapLabels): void {
  const current = node.state === "current";
  const unknown = node.state === "unknown";
  context.fillStyle = current ? colours.current : unknown ? colours.unknown : colours.visited;
  context.strokeStyle = current ? colours.currentLine : unknown ? colours.unknownLine : colours.visitedLine;
  context.lineWidth = current ? 3 : 2;
  context.setLineDash(unknown ? [6, 5] : []);
  roundedBox(context, at.x, at.y, boxWidth, boxHeight, 10);
  context.fill();
  context.stroke();
  context.setLineDash([]);

  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = unknown ? colours.muted : colours.text;
  context.font = `600 ${unknown ? 22 : 15}px "${fontFamily}"`;
  const title = unknown ? labels.unknown : fitted(context, node.title ?? labels.unknown, boxWidth - 20);
  const note = current ? labels.here : node.deadEnd ? labels.deadEnd : node.locked ? labels.locked : "";
  context.fillText(title, at.x + boxWidth / 2, at.y + boxHeight / (note === "" ? 2 : 2.6));
  if (note !== "") {
    context.fillStyle = node.deadEnd ? colours.deadEnd : colours.muted;
    context.font = `11px "${fontFamily}"`;
    context.fillText(note, at.x + boxWidth / 2, at.y + boxHeight * 0.76);
  }
}

function roundedBox(context: SKRSContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}

// The name cut to fit the box, with an ellipsis.
function fitted(context: SKRSContext2D, text: string, width: number): string {
  if (context.measureText(text).width <= width) return text;
  const characters = [...text];
  while (characters.length > 1 && context.measureText(`${characters.join("")}…`).width > width) characters.pop();
  return `${characters.join("")}…`;
}
