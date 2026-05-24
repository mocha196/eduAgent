import type { UserRole } from "@prisma/client";

export type RegisterBody = {
  username: string;
  password: string;
  role: UserRole;
};

export type LoginBody = {
  username: string;
  password: string;
};

export type RefreshBody = {
  refresh_token: string;
};

/** Authenticated user changes their own password (POST /api/v1/me/password). */
export type ChangePasswordBody = {
  current_password: string;
  new_password: string;
};

export type PublicUserDto = {
  id: string;
  username: string;
  role: UserRole;
  real_name: string | null;
};

/** Registration returns the new user. */
export type RegisterResponseDto = {
  user: PublicUserDto;
};

export type LoginResponseDto = {
  token: string;
  refresh_token: string;
  user: PublicUserDto;
};

export type RefreshResponseDto = {
  token: string;
  refresh_token: string;
};
