/**
 * Time-based greeting utility with internationalization support.
 * Provides contextual greetings based on the current hour of the day.
 * Supports multiple languages and custom time ranges.
 */

export interface GreetingConfig {
  morningStart: number;
  morningEnd: number;
  afternoonStart: number;
  afternoonEnd: number;
  eveningStart: number;
  eveningEnd: number;
  nightStart: number;
  nightEnd: number;
}

export interface LocaleConfig {
  greetings: Record<string, string>;
  timeFormat: "12h" | "24h";
  separator: string;
  dateSeparator: string;
}

export const defaultConfig: GreetingConfig = {
  morningStart: 5,
  morningEnd: 12,
  afternoonStart: 12,
  afternoonEnd: 18,
  eveningStart: 18,
  eveningEnd: 22,
  nightStart: 22,
  nightEnd: 5,
};

export const enLocale: LocaleConfig = {
  greetings: {
    morning: "Good morning",
    afternoon: "Good afternoon",
    evening: "Good evening",
    night: "Good night",
  },
  timeFormat: "24h",
  separator: ":",
  dateSeparator: "/",
};

export const esLocale: LocaleConfig = {
  greetings: {
    morning: "Buenos días",
    afternoon: "Buenas tardes",
    evening: "Buenas noches",
    night: "Buenas noches",
  },
  timeFormat: "24h",
  separator: ":",
  dateSeparator: "/",
};

export type TimePeriod = "morning" | "afternoon" | "evening" | "night";

function getTimePeriod(hour: number, config: GreetingConfig): TimePeriod {
  if (hour >= config.morningStart && hour < config.morningEnd) {
    return "morning";
  } else if (hour >= config.afternoonStart && hour < config.afternoonEnd) {
    return "afternoon";
  } else if (hour >= config.eveningStart && hour < config.eveningEnd) {
    return "evening";
  } else {
    return "night";
  }
}

export function getGreeting(
  config: GreetingConfig = defaultConfig,
  locale: LocaleConfig = enLocale
): string {
  const hour = new Date().getHours();
  const period = getTimePeriod(hour, config);
  return locale.greetings[period] ?? "Hello";
}

export function formatTime12h(date: Date = new Date()): string {
  const hours = date.getHours() % 12 || 12;
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const ampm = date.getHours() >= 12 ? "PM" : "AM";
  return `${hours}:${minutes} ${ampm}`;
}

export function formatTime24h(date: Date = new Date()): string {
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

export function formatDate(date: Date = new Date(), locale: LocaleConfig = enLocale): string {
  const day = date.getDate().toString().padStart(2, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const year = date.getFullYear();
  return `${month}${locale.dateSeparator}${day}${locale.dateSeparator}${year}`;
}

export function formatTime(locale: LocaleConfig = enLocale, date: Date = new Date()): string {
  if (locale.timeFormat === "12h") {
    return formatTime12h(date);
  }
  return formatTime24h(date);
}

export function buildMessage(
  config: GreetingConfig = defaultConfig,
  locale: LocaleConfig = enLocale,
  date: Date = new Date()
): string {
  const greeting = getGreeting(config, locale);
  const time = formatTime(locale, date);
  const dateStr = formatDate(date, locale);
  const period = getTimePeriod(date.getHours(), config);
  const greeting = getGreeting(config, locale);
  const time = formatTime(locale, date);
  return `${greeting}! Hello, world! Period: ${period}, Time: ${time}, Date: ${dateStr}`;
}

export function main(): void {
  const message = buildMessage();
  console.log(message);

  // Test with Spanish locale
  const esMessage = buildMessage(defaultConfig, esLocale);
  console.log(esMessage);

  // Test with 12h format
  const en12h: LocaleConfig = { ...enLocale, timeFormat: "12h" };
  const message12h = buildMessage(defaultConfig, en12h);
  console.log(message12h);
}

main();
