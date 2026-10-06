import { Router } from "express";
import { z } from "zod";
import type { Prisma, SlipTemplate } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import { requireImage, singleImage } from "../../middleware/upload.js";
import { deleteFileQuietly, storage } from "../../services/storage/index.js";
import { audit } from "../../utils/audit.js";
import { idParams } from "../../utils/fields.js";
import { AppError, ok, sendPdf } from "../../utils/http.js";
import { requestMeta } from "../../utils/request.js";
import { parse } from "../../utils/validate.js";
import { hospitalScope } from "../hospitals/scope.js";
import {
  SAMPLE_VALUES,
  parseStoredFields,
  slipTemplateBodySchema,
  type SlipTemplateBody,
} from "./slip-fields.js";
import { renderSlips } from "./slip-render.js";

/**
 * /hospital/slip-templates: the hospital admin designs where each piece of data prints on
 * their pre-printed doctor slip. Receptionists and doctors only print with the result.
 */
export const slipTemplatesRouter = Router();

const MAX_TEMPLATES = 10;

export function toSlipTemplateDto(t: SlipTemplate) {
  return {
    id: t.id,
    name: t.name,
    paperWidthMm: t.paperWidthMm,
    paperHeightMm: t.paperHeightMm,
    offsetXMm: t.offsetXMm,
    offsetYMm: t.offsetYMm,
    fields: parseStoredFields(t.fields),
    backgroundImageUrl: t.backgroundImageUrl,
    isDefault: t.isDefault,
    updatedAt: t.updatedAt,
  };
}

async function getOwned(hospitalId: string, id: string) {
  const template = await prisma.slipTemplate.findFirst({ where: { id, hospitalId } });
  if (!template) throw AppError.notFound("Slip template not found");
  return template;
}

const data = (b: SlipTemplateBody) => ({
  name: b.name,
  paperWidthMm: b.paperWidthMm,
  paperHeightMm: b.paperHeightMm,
  offsetXMm: b.offsetXMm,
  offsetYMm: b.offsetYMm,
  fields: b.fields as unknown as Prisma.InputJsonValue,
});

slipTemplatesRouter.get("/", async (req, res) => {
  const { hospitalId } = hospitalScope(req);
  const rows = await prisma.slipTemplate.findMany({
    where: { hospitalId },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    take: MAX_TEMPLATES,
  });
  ok(res, { items: rows.map(toSlipTemplateDto) });
});

slipTemplatesRouter.post("/", async (req, res) => {
  const { hospitalId, actor } = hospitalScope(req);
  const body = parse(slipTemplateBodySchema, req.body);
  const created = await prisma.$transaction(async (tx) => {
    const count = await tx.slipTemplate.count({ where: { hospitalId } });
    if (count >= MAX_TEMPLATES)
      throw AppError.conflict(
        `You can have up to ${MAX_TEMPLATES} slip templates`,
        "TEMPLATE_LIMIT",
      );
    const template = await tx.slipTemplate.create({
      data: { ...data(body), hospitalId, isDefault: count === 0 },
    });
    await audit(tx, {
      actor,
      action: "slip_template.created",
      entityType: "SlipTemplate",
      entityId: template.id,
      hospitalId,
      after: {
        name: template.name,
        paper: `${body.paperWidthMm}x${body.paperHeightMm}mm`,
        fields: body.fields.length,
      },
      meta: requestMeta(req),
    });
    return template;
  });
  ok(res, toSlipTemplateDto(created), 201);
});

export const testPrintSchema = z.object({
  /** The template as it is in the editor right now (saved or not). */
  template: slipTemplateBodySchema,
  /** Rulers and field boxes, for printing on plain paper to check alignment. */
  guides: z.boolean().default(false),
});

/** Prints a sample slip from an unsaved template, so the layout and calibration can be tried before saving. */
slipTemplatesRouter.post("/test-print", async (req, res) => {
  hospitalScope(req);
  const { template, guides } = parse(testPrintSchema, req.body);
  const bytes = await renderSlips(template, [SAMPLE_VALUES], { guides });
  sendPdf(res, guides ? "slip-alignment-sheet.pdf" : "slip-test-print.pdf", bytes);
});

slipTemplatesRouter.get("/:id", async (req, res) => {
  const { hospitalId } = hospitalScope(req);
  const { id } = parse(idParams, req.params);
  ok(res, toSlipTemplateDto(await getOwned(hospitalId, id)));
});

slipTemplatesRouter.patch("/:id", async (req, res) => {
  const { hospitalId, actor } = hospitalScope(req);
  const { id } = parse(idParams, req.params);
  const body = parse(slipTemplateBodySchema, req.body);
  const before = await getOwned(hospitalId, id);
  const updated = await prisma.$transaction(async (tx) => {
    const after = await tx.slipTemplate.update({ where: { id }, data: data(body) });
    await audit(tx, {
      actor,
      action: "slip_template.updated",
      entityType: "SlipTemplate",
      entityId: id,
      hospitalId,
      before: { name: before.name, offsetXMm: before.offsetXMm, offsetYMm: before.offsetYMm },
      after: {
        name: after.name,
        offsetXMm: after.offsetXMm,
        offsetYMm: after.offsetYMm,
        fields: body.fields.length,
      },
      meta: requestMeta(req),
    });
    return after;
  });
  ok(res, toSlipTemplateDto(updated));
});

slipTemplatesRouter.post("/:id/default", async (req, res) => {
  const { hospitalId, actor } = hospitalScope(req);
  const { id } = parse(idParams, req.params);
  await getOwned(hospitalId, id);
  const updated = await prisma.$transaction(async (tx) => {
    await tx.slipTemplate.updateMany({
      where: { hospitalId, isDefault: true, id: { not: id } },
      data: { isDefault: false },
    });
    const t = await tx.slipTemplate.update({ where: { id }, data: { isDefault: true } });
    await audit(tx, {
      actor,
      action: "slip_template.default_set",
      entityType: "SlipTemplate",
      entityId: id,
      hospitalId,
      meta: requestMeta(req),
    });
    return t;
  });
  ok(res, toSlipTemplateDto(updated));
});

slipTemplatesRouter.delete("/:id", async (req, res) => {
  const { hospitalId, actor } = hospitalScope(req);
  const { id } = parse(idParams, req.params);
  const template = await getOwned(hospitalId, id);
  await prisma.$transaction(async (tx) => {
    await tx.slipTemplate.delete({ where: { id } });
    if (template.isDefault) {
      // Keep one default: promote the oldest remaining template.
      const next = await tx.slipTemplate.findFirst({
        where: { hospitalId },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      if (next) await tx.slipTemplate.update({ where: { id: next.id }, data: { isDefault: true } });
    }
    await audit(tx, {
      actor,
      action: "slip_template.deleted",
      entityType: "SlipTemplate",
      entityId: id,
      hospitalId,
      before: { name: template.name },
      meta: requestMeta(req),
    });
  });
  await deleteFileQuietly(template.backgroundKey);
  ok(res, null);
});

/** A scan or photo of the blank paper, shown behind the fields in the editor. It is never printed. */
slipTemplatesRouter.post("/:id/background", singleImage("background"), async (req, res) => {
  const { hospitalId, actor } = hospitalScope(req);
  const { id } = parse(idParams, req.params);
  const before = await getOwned(hospitalId, id);
  const image = requireImage(req);
  const stored = await storage.uploadImage(image, { folder: `hospitals/${hospitalId}/slips` });
  const updated = await prisma.$transaction(async (tx) => {
    const t = await tx.slipTemplate.update({
      where: { id },
      data: { backgroundImageUrl: stored.url, backgroundKey: stored.key },
    });
    await audit(tx, {
      actor,
      action: "slip_template.background_set",
      entityType: "SlipTemplate",
      entityId: id,
      hospitalId,
      meta: requestMeta(req),
    });
    return t;
  });
  await deleteFileQuietly(before.backgroundKey);
  ok(res, toSlipTemplateDto(updated));
});

slipTemplatesRouter.delete("/:id/background", async (req, res) => {
  const { hospitalId, actor } = hospitalScope(req);
  const { id } = parse(idParams, req.params);
  const before = await getOwned(hospitalId, id);
  const updated = await prisma.$transaction(async (tx) => {
    const t = await tx.slipTemplate.update({
      where: { id },
      data: { backgroundImageUrl: null, backgroundKey: null },
    });
    await audit(tx, {
      actor,
      action: "slip_template.background_removed",
      entityType: "SlipTemplate",
      entityId: id,
      hospitalId,
      meta: requestMeta(req),
    });
    return t;
  });
  await deleteFileQuietly(before.backgroundKey);
  ok(res, toSlipTemplateDto(updated));
});
