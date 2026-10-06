-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "confirmedAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "Hospital" ADD COLUMN     "refundFullHours" INTEGER NOT NULL DEFAULT 24,
ADD COLUMN     "refundPartialPercent" INTEGER NOT NULL DEFAULT 50;

-- AlterTable
ALTER TABLE "NotificationLog" ADD COLUMN     "appointmentId" UUID,
ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "nextAttemptAt" TIMESTAMPTZ(3),
ADD COLUMN     "sentAt" TIMESTAMPTZ(3),
ADD COLUMN     "templateVars" JSONB;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "providerMethod" TEXT;

-- AlterTable
ALTER TABLE "Refund" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "error" TEXT,
ADD COLUMN     "nextAttemptAt" TIMESTAMPTZ(3),
ADD COLUMN     "percent" INTEGER;

-- CreateIndex
CREATE INDEX "NotificationLog_status_nextAttemptAt_idx" ON "NotificationLog"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationLog_appointmentId_template_channel_key" ON "NotificationLog"("appointmentId", "template", "channel");

-- CreateIndex
CREATE INDEX "Refund_status_nextAttemptAt_idx" ON "Refund"("status", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

