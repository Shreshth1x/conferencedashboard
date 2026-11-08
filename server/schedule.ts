export const SCHEDULE_TIME_ZONE = 'America/Chicago'
export const SCHEDULE_GAP_MS = 5 * 60_000

const dayMs = 24 * 60 * 60_000
const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: SCHEDULE_TIME_ZONE,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  hourCycle: 'h23',
})

function chicagoWallTime(date: Date): number {
  const parts = Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, Number(value)]))
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
}

function wallTimeToInstant(wallTime: number): number {
  const offset = chicagoWallTime(new Date(wallTime)) - wallTime
  return wallTime - offset
}

function availableBlock(day: number, hour: number, minute: number, occupied: number[], after: number): number[] {
  const blockStart = wallTimeToInstant(day + (hour * 60 + minute) * 60_000)
  return Array.from({ length: 15 }, (_, index) => blockStart + index * SCHEDULE_GAP_MS)
    .filter((slot) => slot > after && occupied.every((time) => Math.abs(time - slot) >= SCHEDULE_GAP_MS))
}

export function generateScheduleSlots({
  count,
  occupied,
  now = new Date(),
  latestDate,
  after,
}: {
  count: number
  occupied: readonly string[]
  now?: Date
  latestDate?: string
  after?: string
}): string[] {
  if (!Number.isInteger(count) || count < 0 || count > 10) {
    throw new RangeError('A schedule can have up to 10 slots.')
  }
  const busy = occupied.map(Date.parse).filter(Number.isFinite)
  const afterTime = after ? Date.parse(after) : -Infinity
  if (Number.isNaN(afterTime)) throw new RangeError('The preceding send time is invalid.')
  const firstDay = Math.floor(chicagoWallTime(now) / dayMs) * dayMs + dayMs
  const selected: number[] = []
  for (let day = firstDay; selected.length < count && day < firstDay + 31 * dayMs; day += dayMs) {
    if (latestDate && new Date(day).toISOString().slice(0, 10) > latestDate) break
    const morning = availableBlock(day, 9, 10, busy, afterTime)
    const afternoon = availableBlock(day, 13, 20, busy, afterTime)
    const remaining = count - selected.length
    const morningCount = Math.min(morning.length, Math.max(Math.ceil(remaining / 2), remaining - afternoon.length))
    selected.push(...morning.slice(0, morningCount), ...afternoon.slice(0, remaining - morningCount))
  }
  return selected.map((time) => new Date(time).toISOString())
}
