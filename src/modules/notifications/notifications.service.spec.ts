import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { NotificationsService } from "./notifications.service";
import { PrismaService } from "../../common/prisma/prisma.service";
import { NotificationType } from "@prisma/client";
import { I18nService } from "../../i18n/i18n.service";

const ALL_TYPES = Object.values(NotificationType);

function allEnabled() {
  return ALL_TYPES.reduce(
    (acc, t) => ({ ...acc, [t]: { inApp: true, email: true, slack: true } }),
    {},
  );
}

const mockUser = {
  id: "user-1",
  stellarAddress: "GABC",
  email: "user@example.com",
};
const mockNotification = {
  id: "notif-1",
  userId: "user-1",
  type: NotificationType.PROOF_SUBMITTED,
};

function buildPrisma(
  prefOverride?: object,
  slackWebhookUrl: string | null = null,
): any {
  return {
    shipment: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findUnique: jest.fn().mockResolvedValue(mockUser) },
    notification: {
      create: jest.fn().mockResolvedValue(mockNotification),
      update: jest.fn().mockResolvedValue(mockNotification),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    notificationPreference: {
      upsert: jest.fn().mockResolvedValue({
        preferences: prefOverride ?? allEnabled(),
        slackWebhookUrl,
      }),
      update: jest.fn().mockResolvedValue({
        preferences: prefOverride ?? allEnabled(),
        slackWebhookUrl,
      }),
    },
    emailSuppression: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    $transaction: jest.fn().mockResolvedValue([[], 0]),
  };
}

async function buildService(prisma: any) {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      NotificationsService,
      { provide: PrismaService, useValue: prisma },
      {
        provide: ConfigService,
        useValue: { get: jest.fn().mockReturnValue(undefined) },
      },
      {
        provide: I18nService,
        useValue: {
          getEmailCopy: jest.fn().mockReturnValue(null),
          t: jest.fn((key: string) => key),
        },
      },
    ],
  }).compile();
  return module.get(NotificationsService);
}

describe("NotificationsService — preferences", () => {
  afterEach(() => jest.clearAllMocks());

  describe("default preferences", () => {
    it("upserts a default preference record on first notifyUser call", async () => {
      const prisma = buildPrisma();
      const service = await buildService(prisma);

      await service.notifyUser(
        "GABC",
        NotificationType.PROOF_SUBMITTED,
        "title",
        "msg",
      );

      expect(prisma.notificationPreference.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: "user-1" } }),
      );
    });

    it("all types default to inApp: true, email: true, slack: true", async () => {
      const prisma = buildPrisma();
      const service = await buildService(prisma);

      const prefs = await service.getOrCreatePreferences("user-1");

      ALL_TYPES.forEach((type) => {
        expect(prefs[type]).toEqual({ inApp: true, email: true, slack: true });
      });
    });
  });

  describe("inApp: false", () => {
    it("skips DB insert when inApp is false for the event type", async () => {
      const prefs = {
        ...allEnabled(),
        [NotificationType.PROOF_SUBMITTED]: { inApp: false, email: true },
      };
      const prisma = buildPrisma(prefs);
      const service = await buildService(prisma);

      const result = await service.notifyUser(
        "GABC",
        NotificationType.PROOF_SUBMITTED,
        "title",
        "msg",
      );

      expect(prisma.notification.create).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it("still creates notification for a different type that has inApp: true", async () => {
      const prefs = {
        ...allEnabled(),
        [NotificationType.PROOF_SUBMITTED]: { inApp: false, email: true },
      };
      const prisma = buildPrisma(prefs);
      const service = await buildService(prisma);

      await service.notifyUser(
        "GABC",
        NotificationType.SHIPMENT_CREATED,
        "title",
        "msg",
      );

      expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    });
  });

  describe("email: false", () => {
    it("skips sendEmail when email preference is false", async () => {
      const prefs = {
        ...allEnabled(),
        [NotificationType.PROOF_SUBMITTED]: { inApp: true, email: false },
      };
      const prisma = buildPrisma(prefs);
      const service = await buildService(prisma);

      // Spy on sendEmail to confirm it is not called
      const sendEmailSpy = jest
        .spyOn(service, "sendEmail")
        .mockResolvedValue(undefined);

      await service.notifyUser(
        "GABC",
        NotificationType.PROOF_SUBMITTED,
        "title",
        "msg",
      );

      expect(prisma.notification.create).toHaveBeenCalledTimes(1);
      expect(sendEmailSpy).not.toHaveBeenCalled();
    });

    it("sends email when email preference is true and user has an email", async () => {
      const prisma = buildPrisma(); // all enabled
      const service = await buildService(prisma);
      const sendEmailSpy = jest
        .spyOn(service, "sendEmail")
        .mockResolvedValue(undefined);

      await service.notifyUser(
        "GABC",
        NotificationType.PROOF_SUBMITTED,
        "title",
        "msg",
      );

      expect(sendEmailSpy).toHaveBeenCalledWith(
        "user@example.com",
        "title",
        "msg",
        undefined,
        NotificationType.PROOF_SUBMITTED,
        undefined,
        "en",
      );
    });
  });

  describe("updatePreferences", () => {
    it("merges partial update into existing preferences", async () => {
      const prisma = buildPrisma();
      const service = await buildService(prisma);

      await service.updatePreferences("user-1", {
        preferences: {
          [NotificationType.PROOF_SUBMITTED]: { inApp: true, email: false },
        },
      });

      expect(prisma.notificationPreference.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: "user-1" },
          data: expect.objectContaining({
            preferences: expect.objectContaining({
              [NotificationType.PROOF_SUBMITTED]: { inApp: true, email: false },
            }),
          }),
        }),
      );
    });
  });

  describe("grouped shipment notifications", () => {
    it("groups notifications by shipment and returns the newest three in each group", async () => {
      const prisma = buildPrisma();
      prisma.notification.findMany.mockResolvedValue([
        {
          id: "n-3",
          userId: "user-1",
          type: NotificationType.PROOF_SUBMITTED,
          title: "Proof received",
          message: "Third",
          data: { shipmentId: "ship-1" },
          read: false,
          createdAt: new Date("2024-01-03T00:00:00Z"),
        },
        {
          id: "n-2",
          userId: "user-1",
          type: NotificationType.DISPUTE_RAISED,
          title: "Dispute raised",
          message: "Second",
          data: { shipmentId: "ship-1" },
          read: true,
          createdAt: new Date("2024-01-02T00:00:00Z"),
        },
        {
          id: "n-1",
          userId: "user-1",
          type: NotificationType.SYSTEM_ALERT,
          title: "System alert",
          message: "General",
          data: {},
          read: false,
          createdAt: new Date("2024-01-01T00:00:00Z"),
        },
      ]);
      prisma.shipment = {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: "ship-1", referenceNumber: "REF-123" }]),
      };

      const service = await buildService(prisma);
      const result = await service.findForUser(
        "user-1",
        false,
        1,
        20,
        "shipment",
      );

      expect(result.data).toHaveLength(2);
      expect(result.data[0]).toMatchObject({
        shipmentId: "ship-1",
        referenceNumber: "REF-123",
        unreadCount: 1,
      });
      expect((result.data[0] as any).notifications).toHaveLength(2);
      expect((result.data[1] as any).shipmentId).toBeNull();
    });

    it("marks all notifications for a shipment as read and returns an updated count", async () => {
      const prisma = buildPrisma();
      prisma.notification.updateMany.mockResolvedValue({ count: 2 });
      prisma.notification.count.mockResolvedValue(1);
      const service = await buildService(prisma);

      const result = await (service as any).markReadByShipment(
        "user-1",
        "ship-1",
      );

      expect(prisma.notification.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: "user-1",
            read: false,
          }),
          data: { read: true },
        }),
      );
      expect(result).toEqual({ updatedCount: 2 });
    });
  });

  describe("Slack channel", () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
      jest.clearAllMocks();
    });

    it("posts to Slack when webhook URL is configured and slack is enabled", async () => {
      const prisma = buildPrisma(
        undefined,
        "https://hooks.slack.com/services/T/B/X",
      );
      const service = await buildService(prisma);
      global.fetch = jest
        .fn()
        .mockResolvedValue({ ok: true, text: async () => "ok" }) as any;

      await service.notifyUser(
        "GABC",
        NotificationType.PROOF_SUBMITTED,
        "Proof in",
        "msg",
        {
          shipmentId: "ship-1",
          milestoneIndex: 0,
        },
      );

      expect(global.fetch).toHaveBeenCalledWith(
        "https://hooks.slack.com/services/T/B/X",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("skips Slack when webhook URL is removed", async () => {
      const prisma = buildPrisma(undefined, null);
      const service = await buildService(prisma);
      global.fetch = jest.fn() as any;

      await service.notifyUser(
        "GABC",
        NotificationType.PROOF_SUBMITTED,
        "Proof in",
        "msg",
      );

      expect(global.fetch).not.toHaveBeenCalled();
      expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    });
  });
});

describe("NotificationsService — snooze", () => {
  const USER_ID = "user-1";
  const NOTIF_ID = "notif-1";

  afterEach(() => jest.clearAllMocks());

  // ── snooze() ──────────────────────────────────────────────────────────────

  describe("snooze()", () => {
    it("calls updateMany with a future snoozedUntil timestamp", async () => {
      const prisma = buildPrisma();
      const service = await buildService(prisma);
      const futureDate = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 h from now

      await service.snooze(USER_ID, NOTIF_ID, futureDate);

      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { id: NOTIF_ID, userId: USER_ID },
        data: { snoozedUntil: new Date(futureDate) },
      });
    });

    it("throws BadRequestException when the until date is in the past", async () => {
      const { BadRequestException } = await import("@nestjs/common");
      const prisma = buildPrisma();
      const service = await buildService(prisma);
      const pastDate = new Date(Date.now() - 1000).toISOString();

      await expect(service.snooze(USER_ID, NOTIF_ID, pastDate)).rejects.toThrow(
        BadRequestException,
      );
      // updateMany must never be called when the date is invalid
      expect(prisma.notification.updateMany).not.toHaveBeenCalled();
    });

    it("throws NotFoundException when no row matches (wrong owner or missing id)", async () => {
      const { NotFoundException } = await import("@nestjs/common");
      const prisma = buildPrisma();
      prisma.notification.updateMany.mockResolvedValue({ count: 0 });
      const service = await buildService(prisma);
      const futureDate = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      await expect(
        service.snooze(USER_ID, NOTIF_ID, futureDate),
      ).rejects.toThrow(NotFoundException);
    });

    it("does not mutate the read flag when snoozing", async () => {
      const prisma = buildPrisma();
      const service = await buildService(prisma);
      const futureDate = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      await service.snooze(USER_ID, NOTIF_ID, futureDate);

      const callData = prisma.notification.updateMany.mock.calls[0][0].data;
      expect(callData).not.toHaveProperty("read");
    });
  });

  // ── unsnooze() ────────────────────────────────────────────────────────────

  describe("unsnooze()", () => {
    it("calls updateMany with snoozedUntil: null", async () => {
      const prisma = buildPrisma();
      const service = await buildService(prisma);

      await service.unsnooze(USER_ID, NOTIF_ID);

      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { id: NOTIF_ID, userId: USER_ID },
        data: { snoozedUntil: null },
      });
    });

    it("throws NotFoundException when no row matches", async () => {
      const { NotFoundException } = await import("@nestjs/common");
      const prisma = buildPrisma();
      prisma.notification.updateMany.mockResolvedValue({ count: 0 });
      const service = await buildService(prisma);

      await expect(service.unsnooze(USER_ID, NOTIF_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── findForUser() snooze filter ───────────────────────────────────────────

  describe("findForUser() — snooze filtering", () => {
    it("passes an OR clause that excludes actively-snoozed notifications", async () => {
      const prisma = buildPrisma();
      prisma.$transaction.mockResolvedValue([[], 0]);
      const service = await buildService(prisma);

      await service.findForUser(USER_ID);

      expect(prisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              { snoozedUntil: null },
              {
                snoozedUntil: expect.objectContaining({ lt: expect.any(Date) }),
              },
            ],
          }),
        }),
      );
    });

    it("includes notifications with a snoozedUntil in the past (expired snooze)", async () => {
      // The OR filter uses lt: new Date(), so an expired-snooze row satisfies the second branch.
      // We verify this by checking the lt value is <= now at the time of the call.
      const prisma = buildPrisma();
      prisma.$transaction.mockResolvedValue([[], 0]);
      const before = new Date();
      const service = await buildService(prisma);

      await service.findForUser(USER_ID);

      const after = new Date();
      const callWhere = prisma.notification.findMany.mock.calls[0][0].where;
      const ltValue: Date = callWhere.OR[1].snoozedUntil.lt;
      expect(ltValue.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(ltValue.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  // ── Localized email delivery (#543) ───────────────────────────────────────

  describe("Localized email delivery (#543)", () => {
    it('passes user.locale = "es" to sendEmail when configured on the user profile', async () => {
      const spanishUser = { ...mockUser, locale: "es" };
      const prisma = buildPrisma();
      prisma.user.findUnique.mockResolvedValue(spanishUser);
      const service = await buildService(prisma);

      const sendEmailSpy = jest
        .spyOn(service, "sendEmail")
        .mockResolvedValue(true);

      await service.notifyUser(
        "GABC",
        NotificationType.DISPUTE_RAISED,
        "Dispute Raised",
        "A dispute was opened",
      );

      expect(sendEmailSpy).toHaveBeenCalledWith(
        "user@example.com",
        "Dispute Raised",
        "A dispute was opened",
        undefined,
        NotificationType.DISPUTE_RAISED,
        undefined,
        "es",
      );
    });

    it('falls back to default locale ("en") when user has no locale property', async () => {
      const noLocaleUser = { ...mockUser, locale: undefined };
      const prisma = buildPrisma();
      prisma.user.findUnique.mockResolvedValue(noLocaleUser);
      const service = await buildService(prisma);

      const sendEmailSpy = jest
        .spyOn(service, "sendEmail")
        .mockResolvedValue(true);

      await service.notifyUser(
        "GABC",
        NotificationType.PAYMENT_RELEASED,
        "Payment Released",
        "Payment released",
      );

      expect(sendEmailSpy).toHaveBeenCalledWith(
        "user@example.com",
        "Payment Released",
        "Payment released",
        undefined,
        NotificationType.PAYMENT_RELEASED,
        undefined,
        "en",
      );
    });

    it("renders Spanish templates when locale=es and falls back to English for unknown locales", async () => {
      const prisma = buildPrisma();
      const service = await buildService(prisma);

      // Access private renderTemplate method for direct validation
      const render = (service as any).renderTemplate.bind(service);

      const esHtml = render(
        NotificationType.PAYMENT_RELEASED,
        { txHash: "0xabc" },
        "es",
      );
      expect(esHtml).toContain("Transacción: <code>0xabc</code>");

      // Unsupported locale falls back to English template
      const fallbackHtml = render(
        NotificationType.PAYMENT_RELEASED,
        { txHash: "0xabc" },
        "fr",
      );
      expect(fallbackHtml).toContain("Transaction: <code>0xabc</code>");
    });
  });
});
