/**
 * Simple user store module — known-good baseline.
 */

export interface User {
  id: string;
  name: string;
  email: string;
  role: "admin" | "user" | "guest";
  active: boolean;
  createdAt: Date;
}

export class UserStore {
  private users: Map<string, User> = new Map();

  add(user: User): void {
    if (!user.id) throw new Error("User must have an id");
    if (!user.email) throw new Error("User must have an email");
    if (this.users.has(user.id)) throw new Error(`User ${user.id} already exists`);
    this.users.set(user.id, { ...user });
  }

  get(id: string): User | undefined {
    const user = this.users.get(id);
    return user ? { ...user } : undefined;
  }

  update(id: string, updates: Partial<Omit<User, "id">>): User {
    const existing = this.users.get(id);
    if (!existing) throw new Error(`User ${id} not found`);
    const updated = { ...existing, ...updates };
    this.users.set(id, updated);
    return { ...updated };
  }

  delete(id: string): boolean {
    return this.users.delete(id);
  }

  findByEmail(email: string): User | undefined {
    for (const user of this.users.values()) {
      if (user.email === email) return { ...user };
    }
    return undefined;
  }

  findByRole(role: User["role"]): User[] {
    const result: User[] = [];
    for (const user of this.users.values()) {
      if (user.role === role) result.push({ ...user });
    }
    return result;
  }

  listActive(): User[] {
    const result: User[] = [];
    for (const user of this.users.values()) {
      if (user.active) result.push({ ...user });
    }
    return result;
  }

  count(): number {
    return this.users.size;
  }

  canAccess(userId: string, resource: string): boolean {
    const user = this.users.get(userId);
    if (!user) return false;
    if (!user.active) return false;
    if (user.role === "admin") return true;
    if (user.role === "guest") return resource === "public";
    return resource !== "admin-panel";
  }

  deactivateInactive(thresholdDays: number): number {
    const threshold = new Date();
    threshold.setDate(threshold.getDate() - thresholdDays);
    let count = 0;
    for (const user of this.users.values()) {
      if (user.active && user.createdAt < threshold) {
        user.active = false;
        count++;
      }
    }
    return count;
  }
}

export function validateEmail(email: string): boolean {
  if (!email) return false;
  const parts = email.split("@");
  if (parts.length !== 2) return false;
  if (parts[0].length === 0 || parts[1].length === 0) return false;
  if (!parts[1].includes(".")) return false;
  return true;
}

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
