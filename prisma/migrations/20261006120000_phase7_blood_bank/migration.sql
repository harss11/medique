-- CreateEnum
CREATE TYPE "BloodBankStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'REJECTED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "BloodRequestStatus" AS ENUM ('OPEN', 'FULFILLED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "BloodUrgency" AS ENUM ('EMERGENCY', 'URGENT');

-- CreateEnum
CREATE TYPE "BloodResponseKind" AS ENUM ('CAN_HELP', 'CANNOT');

-- AlterEnum
ALTER TYPE "ConsentType" ADD VALUE 'DONOR_ALERTS';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OtpPurpose" ADD VALUE 'BLOOD_REQUEST';
ALTER TYPE "OtpPurpose" ADD VALUE 'BLOOD_BANK_REGISTRATION';
ALTER TYPE "OtpPurpose" ADD VALUE 'BLOOD_REQUEST_RECOVERY';

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'BLOOD_BANK_STAFF';

-- AlterTable
ALTER TABLE "NotificationLog" ADD COLUMN     "groupKey" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "bloodBankId" UUID;

-- CreateTable
CREATE TABLE "BloodBank" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "licenseNumber" TEXT NOT NULL,
    "licenseAuthority" TEXT,
    "licenseValidUntil" DATE,
    "status" "BloodBankStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "addressLine1" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "state" TEXT,
    "postalCode" TEXT,
    "country" TEXT NOT NULL DEFAULT 'IN',
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "is24x7" BOOLEAN NOT NULL DEFAULT false,
    "operatingHours" TEXT,
    "verifiedAt" TIMESTAMPTZ(3),
    "verifiedById" UUID,
    "rejectedReason" TEXT,
    "blockedAt" TIMESTAMPTZ(3),
    "blockedReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BloodBank_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BloodStock" (
    "id" UUID NOT NULL,
    "bloodBankId" UUID NOT NULL,
    "bloodGroup" "BloodGroup" NOT NULL,
    "units" INTEGER NOT NULL,
    "updatedById" UUID,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BloodStock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DonorProfile" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "bloodGroup" "BloodGroup" NOT NULL,
    "gender" "Gender" NOT NULL,
    "dateOfBirth" DATE NOT NULL,
    "city" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "lastDonationAt" TIMESTAMPTZ(3),
    "alertsConsentAt" TIMESTAMPTZ(3) NOT NULL,
    "alertsConsentVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "DonorProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Donation" (
    "id" UUID NOT NULL,
    "donorId" UUID,
    "bloodBankId" UUID NOT NULL,
    "recordedById" UUID NOT NULL,
    "donatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bloodGroup" "BloodGroup" NOT NULL,
    "volumeMl" INTEGER NOT NULL,
    "voidedAt" TIMESTAMPTZ(3),
    "voidedById" UUID,
    "voidReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Donation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BloodRequest" (
    "id" UUID NOT NULL,
    "requesterPhone" TEXT NOT NULL,
    "requesterName" TEXT NOT NULL,
    "requesterKeyHash" TEXT NOT NULL,
    "bloodGroup" "BloodGroup" NOT NULL,
    "unitsNeeded" INTEGER NOT NULL,
    "urgency" "BloodUrgency" NOT NULL,
    "hospitalName" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "radiusKm" INTEGER NOT NULL DEFAULT 25,
    "note" TEXT,
    "status" "BloodRequestStatus" NOT NULL DEFAULT 'OPEN',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "closedAt" TIMESTAMPTZ(3),
    "createdIp" TEXT,
    "alertedDonors" INTEGER NOT NULL DEFAULT 0,
    "alertedBanks" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BloodRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BloodRequestAlert" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "donorId" UUID,
    "bloodBankId" UUID,
    "distanceKm" DOUBLE PRECISION,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BloodRequestAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BloodRequestResponse" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "donorId" UUID,
    "bloodBankId" UUID,
    "response" "BloodResponseKind" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BloodRequestResponse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BloodBank_licenseNumber_key" ON "BloodBank"("licenseNumber");

-- CreateIndex
CREATE INDEX "BloodBank_status_city_idx" ON "BloodBank"("status", "city");

-- CreateIndex
CREATE UNIQUE INDEX "BloodStock_bloodBankId_bloodGroup_key" ON "BloodStock"("bloodBankId", "bloodGroup");

-- CreateIndex
CREATE UNIQUE INDEX "DonorProfile_userId_key" ON "DonorProfile"("userId");

-- CreateIndex
CREATE INDEX "DonorProfile_bloodGroup_isAvailable_idx" ON "DonorProfile"("bloodGroup", "isAvailable");

-- CreateIndex
CREATE INDEX "Donation_donorId_donatedAt_idx" ON "Donation"("donorId", "donatedAt");

-- CreateIndex
CREATE INDEX "Donation_bloodBankId_donatedAt_idx" ON "Donation"("bloodBankId", "donatedAt");

-- CreateIndex
CREATE INDEX "BloodRequest_status_expiresAt_idx" ON "BloodRequest"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "BloodRequest_requesterPhone_createdAt_idx" ON "BloodRequest"("requesterPhone", "createdAt");

-- CreateIndex
CREATE INDEX "BloodRequest_bloodGroup_status_idx" ON "BloodRequest"("bloodGroup", "status");

-- CreateIndex
CREATE INDEX "BloodRequestAlert_donorId_createdAt_idx" ON "BloodRequestAlert"("donorId", "createdAt");

-- CreateIndex
CREATE INDEX "BloodRequestAlert_bloodBankId_createdAt_idx" ON "BloodRequestAlert"("bloodBankId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BloodRequestAlert_requestId_donorId_key" ON "BloodRequestAlert"("requestId", "donorId");

-- CreateIndex
CREATE UNIQUE INDEX "BloodRequestAlert_requestId_bloodBankId_key" ON "BloodRequestAlert"("requestId", "bloodBankId");

-- CreateIndex
CREATE INDEX "BloodRequestResponse_requestId_response_idx" ON "BloodRequestResponse"("requestId", "response");

-- CreateIndex
CREATE UNIQUE INDEX "BloodRequestResponse_requestId_donorId_key" ON "BloodRequestResponse"("requestId", "donorId");

-- CreateIndex
CREATE UNIQUE INDEX "BloodRequestResponse_requestId_bloodBankId_key" ON "BloodRequestResponse"("requestId", "bloodBankId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationLog_groupKey_template_channel_to_key" ON "NotificationLog"("groupKey", "template", "channel", "to");

-- CreateIndex
CREATE INDEX "User_bloodBankId_role_idx" ON "User"("bloodBankId", "role");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_bloodBankId_fkey" FOREIGN KEY ("bloodBankId") REFERENCES "BloodBank"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BloodBank" ADD CONSTRAINT "BloodBank_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BloodStock" ADD CONSTRAINT "BloodStock_bloodBankId_fkey" FOREIGN KEY ("bloodBankId") REFERENCES "BloodBank"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BloodStock" ADD CONSTRAINT "BloodStock_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DonorProfile" ADD CONSTRAINT "DonorProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Donation" ADD CONSTRAINT "Donation_donorId_fkey" FOREIGN KEY ("donorId") REFERENCES "DonorProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Donation" ADD CONSTRAINT "Donation_bloodBankId_fkey" FOREIGN KEY ("bloodBankId") REFERENCES "BloodBank"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Donation" ADD CONSTRAINT "Donation_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Donation" ADD CONSTRAINT "Donation_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BloodRequestAlert" ADD CONSTRAINT "BloodRequestAlert_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "BloodRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BloodRequestAlert" ADD CONSTRAINT "BloodRequestAlert_donorId_fkey" FOREIGN KEY ("donorId") REFERENCES "DonorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BloodRequestAlert" ADD CONSTRAINT "BloodRequestAlert_bloodBankId_fkey" FOREIGN KEY ("bloodBankId") REFERENCES "BloodBank"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BloodRequestResponse" ADD CONSTRAINT "BloodRequestResponse_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "BloodRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BloodRequestResponse" ADD CONSTRAINT "BloodRequestResponse_donorId_fkey" FOREIGN KEY ("donorId") REFERENCES "DonorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BloodRequestResponse" ADD CONSTRAINT "BloodRequestResponse_bloodBankId_fkey" FOREIGN KEY ("bloodBankId") REFERENCES "BloodBank"("id") ON DELETE CASCADE ON UPDATE CASCADE;

