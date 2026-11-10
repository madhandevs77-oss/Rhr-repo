import { describe, expect, test } from 'vitest'
import { cap, digits, fmt, fmtMoney, fmtTime, initials, isPhone, parseISO, toISO, waLink } from '../utils'

describe('money and dates', () => {
  test('fmt formats rupees in Indian grouping, empty/invalid as zero', () => {
    expect(fmt(1234567)).toBe('₹12,34,567')
    expect(fmt(0)).toBe('₹0')
    expect(fmt(null)).toBe('₹0')
    expect(fmt(undefined)).toBe('₹0')
    expect(fmt('abc')).toBe('₹0')
    expect(fmt(1999.5)).toBe('₹1,999.5')
    expect(fmt(-500)).toBe('-₹500')
  })
  test('fmtMoney keeps two decimals for fractional amounts only', () => {
    expect(fmtMoney(100)).toBe('₹100')
    expect(fmtMoney(100.5)).toMatch(/₹100\.50/)
  })
  test('toISO/parseISO round-trip without timezone drift', () => {
    expect(toISO(parseISO('2026-12-31'))).toBe('2026-12-31')
    expect(toISO(parseISO('2027-01-01'))).toBe('2027-01-01')
  })
  test('fmtTime: 12-hour clock incl. midnight, noon, empty', () => {
    expect(fmtTime('00:05')).toBe('12:05 AM')
    expect(fmtTime('12:00')).toBe('12:00 PM')
    expect(fmtTime('18:30')).toBe('6:30 PM')
    expect(fmtTime('')).toBe('')
    expect(fmtTime(null)).toBe('')
  })
})

describe('phone and text helpers', () => {
  test('isPhone needs exactly ten digits (spaces and dashes ignored)', () => {
    expect(isPhone('98765 43210')).toBe(true)
    expect(isPhone('987654321')).toBe(false)
    expect(isPhone('98765432101')).toBe(false)
    expect(isPhone('')).toBe(false)
    expect(isPhone(null)).toBe(false)
  })
  test('digits / waLink', () => {
    expect(digits('+91 98765-43210')).toBe('919876543210')
    expect(waLink('9876543210')).toBe('https://wa.me/919876543210')
    expect(waLink('+91 98765 43210')).toBe('https://wa.me/919876543210')
  })
  test('initials and cap', () => {
    expect(initials('Madhan Raj Kumar')).toBe('MR')
    expect(initials('')).toBe('?')
    expect(cap('part_paid')).toBe('Part paid')
    expect(cap(null)).toBe('')
  })
})
