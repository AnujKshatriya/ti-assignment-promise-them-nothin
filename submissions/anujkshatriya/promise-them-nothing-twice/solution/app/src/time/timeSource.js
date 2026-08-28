'use strict';

class SystemTime {
  now() {
    return Date.now();
  }
}

class FakeTime {
  constructor(initialMs = 0) {
    this._ms = initialMs;
  }

  now() {
    return this._ms;
  }

  setTime(ms) {
    this._ms = ms;
  }

  advance(ms) {
    this._ms += ms;
  }
}

module.exports = { SystemTime, FakeTime };
