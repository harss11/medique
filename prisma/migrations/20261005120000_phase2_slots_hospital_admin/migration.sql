-- CreateEnum
CREATE TYPE "SlotStatus" AS ENUM ('OPEN', 'BLOCKED');

-- DropIndex
DROP INDEX "Appointment_doctorId_slotStart_seatNumber_key";

-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "slotId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "Doctor" ADD COLUMN     "photoKey" TEXT;

-- AlterTable
ALTER TABLE "Hospital" ADD COLUMN     "blockedAt" TIMESTAMPTZ(3),
ADD COLUMN     "blockedReason" TEXT;

-- CreateTable
CREATE TABLE "Slot" (
    "id" UUID NOT NULL,
    "hospitalId" UUID NOT NULL,
    "doctorId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "startAt" TIMESTAMPTZ(3) NOT NULL,
    "endAt" TIMESTAMPTZ(3) NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 1,
    "bookedCount" INTEGER NOT NULL DEFAULT 0,
    "status" "SlotStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Slot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Slot_doctorId_date_idx" ON "Slot"("doctorId", "date");

-- CreateIndex
CREATE INDEX "Slot_hospitalId_date_idx" ON "Slot"("hospitalId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Slot_doctorId_startAt_key" ON "Slot"("doctorId", "startAt");

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_slotId_seatNumber_key" ON "Appointment"("slotId", "seatNumber");

-- AddForeignKey
ALTER TABLE "Slot" ADD CONSTRAINT "Slot_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Slot" ADD CONSTRAINT "Slot_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "Slot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

