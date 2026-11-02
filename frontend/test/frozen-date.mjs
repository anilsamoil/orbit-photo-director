export function installFrozenDate(fixed) {
  const NativeDate = Date;
  function FrozenDate(...args) {
    if (new.target === undefined) return new NativeDate(fixed).toString();
    if (args.length === 0) return Reflect.construct(NativeDate, [fixed], new.target);
    return Reflect.construct(NativeDate, args, new.target);
  }
  Object.setPrototypeOf(FrozenDate, NativeDate);
  FrozenDate.prototype = NativeDate.prototype;
  FrozenDate.now = () => fixed;
  globalThis.Date = FrozenDate;
}
