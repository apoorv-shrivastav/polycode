/**
 * Simple calculator module — known-good baseline.
 */

export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

export function divide(a: number, b: number): number {
  if (b === 0) throw new Error("Division by zero");
  return a / b;
}

export function average(nums: number[]): number {
  if (nums.length === 0) throw new Error("Cannot average empty array");
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

export function clamp(value: number, min: number, max: number): number {
  if (min > max) throw new Error("min must be <= max");
  return Math.max(min, Math.min(max, value));
}

export function range(start: number, end: number): number[] {
  const result: number[] = [];
  for (let i = start; i < end; i++) {
    result.push(i);
  }
  return result;
}

export function fibonacci(n: number): number {
  if (n < 0) throw new Error("n must be non-negative");
  if (n <= 1) return n;
  let a = 0, b = 1;
  for (let i = 2; i <= n; i++) {
    const temp = a + b;
    a = b;
    b = temp;
  }
  return b;
}

export function isPrime(n: number): boolean {
  if (n < 2) return false;
  if (n === 2) return true;
  if (n % 2 === 0) return false;
  for (let i = 3; i <= Math.sqrt(n); i += 2) {
    if (n % i === 0) return false;
  }
  return true;
}
