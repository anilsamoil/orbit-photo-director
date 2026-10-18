export function installFrozenDate(fixed) {
  const NativeDate = Date;
  class FixedDate extends NativeDate {
    constructor(value, month, date, hours, minutes, seconds, ms) {
      if (arguments.length === 0) super(fixed);
      else if (arguments.length === 1) super(value);
      else super(value, month, date, hours, minutes, seconds, ms);
    }

    static now() {
      return fixed;
    }
  }
  globalThis.Date = FixedDate;
}
