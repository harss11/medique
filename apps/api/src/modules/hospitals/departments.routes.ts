import { Router } from "express";
import { z } from "zod";
import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../../utils/audit.js";
import { idParams, nullableText, queryBool } from "../../utils/fields.js";
import { AppError, ok } from "../../utils/http.js";
import { paginate, paginationQuery, toSkipTake } from "../../utils/pagination.js";
import { requestMeta } from "../../utils/request.js";
import { parse } from "../../utils/validate.js";
import { hospitalScope } from "./scope.js";

/** /hospital/departments — CRUD for the signed-in hospital's departments. */
export const departmentsRouter = Router();

export const listQuery = paginationQuery.extend({
  search: z.string().trim().max(100).optional(),
  active: queryBool.optional(),
});

export const createSchema = z.object({
  name: z.string().trim().min(2, "Enter a name").max(100),
  description: nullableText(500),
  sortOrder: z.number().int().min(0).max(1000).optional(),
});

export const updateSchema = createSchema.partial().extend({ isActive: z.boolean().optional() });

function rethrowDuplicate(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    throw AppError.conflict("A department with this name already exists", "DEPARTMENT_EXISTS");
  }
  throw err;
}

async function getOwned(hospitalId: string, id: string) {
  const department = await prisma.department.findFirst({ where: { id, hospitalId } });
  if (!department) throw AppError.notFound("Department not found");
  return department;
}

departmentsRouter.get("/", async (req, res) => {
  const { hospitalId } = hospitalScope(req);
  const q = parse(listQuery, req.query);
  const where: Prisma.DepartmentWhereInput = {
    hospitalId,
    isActive: q.active,
    name: q.search ? { contains: q.search, mode: "insensitive" } : undefined,
  };
  const [rows, total] = await prisma.$transaction([
    prisma.department.findMany({
      where,
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      ...toSkipTake(q),
      include: { _count: { select: { doctors: true } } },
    }),
    prisma.department.count({ where }),
  ]);
  const items = rows.map(({ _count, ...d }) => ({ ...d, doctorCount: _count.doctors }));
  ok(res, paginate(items, total, q));
});

departmentsRouter.post("/", async (req, res) => {
  const { hospitalId, actor } = hospitalScope(req);
  const body = parse(createSchema, req.body);
  const department = await prisma
    .$transaction(async (tx) => {
      const created = await tx.department.create({ data: { ...body, hospitalId } });
      await audit(tx, {
        actor,
        action: "department.created",
        entityType: "Department",
        entityId: created.id,
        hospitalId,
        after: created,
        meta: requestMeta(req),
      });
      return created;
    })
    .catch(rethrowDuplicate);
  ok(res, department, 201);
});

departmentsRouter.patch("/:id", async (req, res) => {
  const { hospitalId, actor } = hospitalScope(req);
  const { id } = parse(idParams, req.params);
  const body = parse(updateSchema, req.body);
  const before = await getOwned(hospitalId, id);
  const department = await prisma
    .$transaction(async (tx) => {
      const after = await tx.department.update({ where: { id }, data: body });
      await audit(tx, {
        actor,
        action: "department.updated",
        entityType: "Department",
        entityId: id,
        hospitalId,
        before,
        after,
        meta: requestMeta(req),
      });
      return after;
    })
    .catch(rethrowDuplicate);
  ok(res, department);
});

/** Only empty departments can be deleted; otherwise deactivate them. */
departmentsRouter.delete("/:id", async (req, res) => {
  const { hospitalId, actor } = hospitalScope(req);
  const { id } = parse(idParams, req.params);
  const before = await getOwned(hospitalId, id);
  const doctorCount = await prisma.doctor.count({ where: { departmentId: id } });
  if (doctorCount > 0) {
    throw AppError.conflict(
      "This department has doctors. Move them or deactivate the department instead.",
      "DEPARTMENT_IN_USE",
    );
  }
  await prisma.$transaction(async (tx) => {
    await tx.department.delete({ where: { id } });
    await audit(tx, {
      actor,
      action: "department.deleted",
      entityType: "Department",
      entityId: id,
      hospitalId,
      before,
      meta: requestMeta(req),
    });
  });
  ok(res, null);
});
