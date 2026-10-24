/* SPDX-License-Identifier: LGPL-3.0-or-later
 * Copyright 2026 ssfxx0923
 */

/**
 * Find the monitor whose selected edge contains the pointer.
 *
 * @param {object[]} monitors - Logical monitor rectangles, including their index.
 * @param {number} x - Pointer X in logical pixels.
 * @param {number} y - Pointer Y in logical pixels.
 * @param {string} edge - Right or top screen edge.
 * @param {number} width - Trigger strip width in logical pixels.
 * @returns {number|null} Matching monitor index.
 */
export function monitorAtEdge(monitors, x, y, edge, width) {
  for (const monitor of monitors) {
    if (x < monitor.x || x >= monitor.x + monitor.width ||
        y < monitor.y || y >= monitor.y + monitor.height)
      continue;
    if (edge === "right" && x >= monitor.x + monitor.width - width)
      return monitor.index;
    if (edge === "top" && y < monitor.y + width)
      return monitor.index;
  }
  return null;
}

/**
 * Calculate a translation that moves the entire window past its screen edge.
 *
 * @param {string} edge - Right or top screen edge.
 * @param {object} frame - Window frame in logical pixels.
 * @param {object} area - Monitor work area in logical pixels.
 * @returns {object} Actor translation properties.
 */
export function slideOffset(edge, frame, area) {
  return edge === "right"
    ? { translation_x: area.x + area.width - frame.x, translation_y: 0 }
    : { translation_x: 0, translation_y: area.y - frame.y - frame.height };
}

/**
 * Keep an animated actor inside its monitor, including on stacked displays.
 *
 * @param {object} actor - Actor position, size and translations.
 * @param {object} area - Monitor work area.
 * @param {number[]|null} original - Original actor-local clipping rectangle.
 * @returns {number[]} Actor-local clipping rectangle.
 */
export function animationClip(actor, area, original = null) {
  const [x, y, width, height] = original || [0, 0, actor.width, actor.height];
  const screenX = actor.x + actor.translation_x;
  const screenY = actor.y + actor.translation_y;
  const left = Math.max(x, area.x - screenX);
  const top = Math.max(y, area.y - screenY);
  return [
    left,
    top,
    Math.max(0, Math.min(x + width, area.x + area.width - screenX) - left),
    Math.max(0, Math.min(y + height, area.y + area.height - screenY) - top),
  ];
}

/** A cancellable dwell trigger that fires only once per visit to an edge. */
export class EdgeDwell {
  /**
   * @param {Function} schedule - Schedule a callback after a delay.
   * @param {Function} cancel - Cancel a scheduled callback.
   * @param {Function} activate - Show the window on the selected monitor.
   */
  constructor(schedule, cancel, activate) {
    this._schedule = schedule;
    this._cancel = cancel;
    this._activate = activate;
    this._monitor = null;
    this._timer = null;
  }

  /**
   * @param {number|null} monitor - Monitor index, or null when outside the edge.
   * @param {number} delay - Required dwell time in milliseconds.
   */
  update(monitor, delay) {
    if (monitor === this._monitor)
      return;
    this.reset();
    this._monitor = monitor;
    if (monitor === null)
      return;
    this._timer = this._schedule(delay, () => {
      this._timer = null;
      this._activate(monitor);
    });
  }

  /** Cancel a pending dwell, including when the extension is disabled. */
  reset() {
    if (this._timer !== null)
      this._cancel(this._timer);
    this._timer = null;
    this._monitor = null;
  }
}
