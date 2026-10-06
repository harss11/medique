import { z } from "zod";

export const MAX_PAGE_SIZE = 100;

/** Query-string schema shared by every list endpoint: ?page=1&limit=20 */
export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
});

export type PaginationQuery = z.infer<typeof paginationQuery>;

export interface Paginated<T> {
  items: T[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

/** Prisma `skip`/`take` for a page. */
export function toSkipTake({ page, limit }: PaginationQuery) {
  return { skip: (page - 1) * limit, take: limit };
}

export function paginate<T>(
  items: T[],
  total: number,
  { page, limit }: PaginationQuery,
): Paginated<T> {
  return {
    items,
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}
