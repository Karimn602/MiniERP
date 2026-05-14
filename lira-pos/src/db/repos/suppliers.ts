import { execute, query } from "../client";
import { newId } from "../../lib/ids";
import type { Supplier } from "../types";

interface SupplierRow {
  id: string;
  store_id: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

function toDomain(r: SupplierRow): Supplier {
  return {
    id: r.id,
    storeId: r.store_id,
    name: r.name,
    contactName: r.contact_name,
    phone: r.phone,
    email: r.email,
    notes: r.notes,
    isActive: r.is_active === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export const suppliersRepo = {
  async list(args: {
    storeId: string;
    search?: string;
    includeInactive?: boolean;
    limit?: number;
  }): Promise<Supplier[]> {
    const includeInactive = args.includeInactive ?? false;
    const limit = args.limit ?? 200;
    const search = args.search?.trim();

    if (!search) {
      const rows = await query<SupplierRow>(
        `SELECT * FROM suppliers
         WHERE store_id = ? ${includeInactive ? "" : "AND is_active = 1"}
         ORDER BY name
         LIMIT ?`,
        [args.storeId, limit],
      );
      return rows.map(toDomain);
    }

    const like = `%${search}%`;
    const rows = await query<SupplierRow>(
      `SELECT * FROM suppliers
       WHERE store_id = ?
         AND (name LIKE ? OR contact_name LIKE ? OR phone LIKE ? OR email LIKE ?)
         ${includeInactive ? "" : "AND is_active = 1"}
       ORDER BY name
       LIMIT ?`,
      [args.storeId, like, like, like, like, limit],
    );
    return rows.map(toDomain);
  },

  async findById(id: string): Promise<Supplier | null> {
    const rows = await query<SupplierRow>(
      `SELECT * FROM suppliers WHERE id = ?`,
      [id],
    );
    return rows[0] ? toDomain(rows[0]) : null;
  },

  async create(args: {
    storeId: string;
    name: string;
    contactName?: string | null;
    phone?: string | null;
    email?: string | null;
    notes?: string | null;
  }): Promise<Supplier> {
    const id = newId();
    await execute(
      `INSERT INTO suppliers
         (id, store_id, name, contact_name, phone, email, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        args.storeId,
        args.name.trim(),
        args.contactName ?? null,
        args.phone ?? null,
        args.email ?? null,
        args.notes ?? null,
      ],
    );
    const created = await this.findById(id);
    if (!created) throw new Error("Supplier vanished after insert");
    return created;
  },

  async setActive(id: string, active: boolean): Promise<void> {
    await execute(`UPDATE suppliers SET is_active = ? WHERE id = ?`, [
      active ? 1 : 0,
      id,
    ]);
  },
};
