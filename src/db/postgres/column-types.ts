import { bigint, customType } from "drizzle-orm/pg-core";

export const bigInteger = (name: string) => bigint(name, { mode: "number" });

export const integerBoolean = customType<{ data: boolean; driverData: number }>({
  dataType: () => "bigint",
  fromDriver: (value) => Number(value) !== 0,
  toDriver: (value) => (value ? 1 : 0),
});
