/**
 * .NET's DateTime.ToString(format) for a custom format string, which is what the Output window's
 * "Timestamp format" option holds (dnSpy's default is "HH:mm:ss.fff"). The specifiers are .NET's custom ones —
 * h/hh, H/HH, m/mm, s/ss, f to fffffff and F to FFFFFFF, t/tt, d to dddd, M to MMMM, y to yyyyy, z to zzz, K —
 * with quoted text, `\` escapes and `%` as .NET reads them. Names of days and months, and the AM/PM designator,
 * come from the locale.
 */
export const formatDateTime = (date: Date, format: string, locale?: string): string => {
  const pad = (value: number, width: number): string => String(value).padStart(width, '0')
  const name = (options: Intl.DateTimeFormatOptions): string => new Intl.DateTimeFormat(locale, options).format(date)
  let result = ''
  for (let index = 0; index < format.length;) {
    const char = format[index]
    if (char === '"' || char === "'") {
      const end = format.indexOf(char, index + 1)
      result += format.slice(index + 1, end < 0 ? format.length : end)
      index = end < 0 ? format.length : end + 1
      continue
    }
    if (char === '\\') {
      result += format[index + 1] ?? ''
      index += 2
      continue
    }
    if (char === '%') {
      index++
      continue
    }
    let count = 1
    while (format[index + count] === char)
      count++
    const hours = date.getHours()
    switch (char) {
      case 'h': result += pad(hours % 12 || 12, Math.min(count, 2)); break
      case 'H': result += pad(hours, Math.min(count, 2)); break
      case 'm': result += pad(date.getMinutes(), Math.min(count, 2)); break
      case 's': result += pad(date.getSeconds(), Math.min(count, 2)); break
      case 'f':
      case 'F': {
        const digits = pad(date.getMilliseconds(), 3).padEnd(7, '0').slice(0, Math.min(count, 7))
        result += char === 'F' ? digits.replace(/0+$/, '') : digits
        break
      }
      case 't': {
        const designator = new Intl.DateTimeFormat(locale, { hour: 'numeric', hour12: true }).formatToParts(date).find((part) => part.type === 'dayPeriod')?.value ?? (hours < 12 ? 'AM' : 'PM')
        result += count === 1 ? designator.charAt(0) : designator
        break
      }
      case 'd': result += count <= 2 ? pad(date.getDate(), count) : name({ weekday: count === 3 ? 'short' : 'long' }); break
      case 'M': result += count <= 2 ? pad(date.getMonth() + 1, count) : name({ month: count === 3 ? 'short' : 'long' }); break
      case 'y': {
        const year = date.getFullYear()
        result += count === 1 ? String(year % 100) : count === 2 ? pad(year % 100, 2) : pad(year, count)
        break
      }
      case 'z': {
        const offset = -date.getTimezoneOffset()
        const sign = offset < 0 ? '-' : '+'
        const absolute = Math.abs(offset)
        result += count === 1 ? `${sign}${Math.trunc(absolute / 60)}`
          : count === 2 ? `${sign}${pad(Math.trunc(absolute / 60), 2)}`
            : `${sign}${pad(Math.trunc(absolute / 60), 2)}:${pad(absolute % 60, 2)}`
        break
      }
      case 'K': {
        const offset = -date.getTimezoneOffset()
        result += `${offset < 0 ? '-' : '+'}${pad(Math.trunc(Math.abs(offset) / 60), 2)}:${pad(Math.abs(offset) % 60, 2)}`.repeat(count)
        break
      }
      case 'g': result += (date.getFullYear() > 0 ? 'A.D.' : 'B.C.'); break
      default: result += char.repeat(count)
    }
    index += count
  }
  return result
}
