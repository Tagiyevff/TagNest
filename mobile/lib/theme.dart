import 'package:flutter/material.dart';

class AppColors {
  static const bg = Color(0xFFE8ECEF);
  static const surface = Color(0xFFF7F9FA);
  static const surface2 = Color(0xFFEEF2F4);
  static const ink = Color(0xFF172027);
  static const ink2 = Color(0xFF4C5A64);
  static const ink3 = Color(0xFF7C8992);
  static const line = Color(0x1A172027);
  static const accent = Color(0xFF2A343C);
  static const ok = Color(0xFF2F6B46);
  static const warn = Color(0xFF8A5A19);
  static const err = Color(0xFF983A2C);
  static const desktop = Color(0xFF151B20);
}

ThemeData buildTheme() {
  final scheme = ColorScheme.fromSeed(
    seedColor: AppColors.accent,
    brightness: Brightness.light,
    primary: AppColors.accent,
    surface: AppColors.surface,
    error: AppColors.err,
  );
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: AppColors.bg,
    splashFactory: InkSparkle.splashFactory,
    appBarTheme: const AppBarTheme(
      backgroundColor: AppColors.bg,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      centerTitle: false,
      foregroundColor: AppColors.ink,
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: AppColors.surface2,
      surfaceTintColor: Colors.transparent,
      indicatorColor: Colors.white,
      height: 62,
      labelTextStyle: WidgetStateProperty.resolveWith((states) {
        return TextStyle(
          fontSize: 11.5,
          fontWeight: states.contains(WidgetState.selected) ? FontWeight.w700 : FontWeight.w500,
          color: states.contains(WidgetState.selected) ? AppColors.ink : AppColors.ink2,
        );
      }),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: Colors.white,
      contentPadding: const EdgeInsets.symmetric(horizontal: 13, vertical: 12),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: AppColors.line),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: AppColors.line),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: Color(0x7A2A343C)),
      ),
      labelStyle: const TextStyle(color: AppColors.ink2, fontSize: 12),
      hintStyle: const TextStyle(color: AppColors.ink3, fontSize: 16),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: AppColors.accent,
        foregroundColor: const Color(0xFFF3F6F8),
        minimumSize: const Size(0, 46),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(11)),
        textStyle: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: AppColors.ink,
        minimumSize: const Size(0, 44),
        side: const BorderSide(color: AppColors.line),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(11)),
        textStyle: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
      ),
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: AppColors.ink,
      contentTextStyle: const TextStyle(color: Color(0xFFF1F5F7), fontSize: 12.5),
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
    ),
    dividerTheme: const DividerThemeData(color: AppColors.line, thickness: 1),
  );
}
