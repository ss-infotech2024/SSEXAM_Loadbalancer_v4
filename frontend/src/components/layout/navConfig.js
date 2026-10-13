// Navigation for each role. `match` lists path prefixes that should also mark the item active.
import {
  LayoutDashboard, Users, UserPlus, QrCode, ClipboardList, FilePlus2,
  ScanLine, BarChart3, ShieldCheck, Building2, GraduationCap, Trophy, Library,
} from "lucide-react";

export const ADMIN_NAV = [
  {
    label: "Overview",
    items: [{ to: "/admin/dashboard", label: "Dashboard", icon: LayoutDashboard }],
  },
  {
    label: "Students",
    items: [
      { to: "/admin/view-students",           label: "All students",     icon: Users },
      { to: "/admin/add-student",             label: "Add students",     icon: UserPlus },
      { to: "/admin/student-registration-qr", label: "Registration QR",  icon: QrCode },
    ],
  },
  {
    label: "Exams",
    items: [
      { to: "/admin/exams",       label: "Exams",         icon: ClipboardList, match: ["/admin/exams", "/admin/get-exams"] },
      { to: "/admin/create-exam", label: "Create exam",   icon: FilePlus2 },
      { to: "/admin/question-library", label: "Question library", icon: Library },
      { to: "/admin/qr-scanner",  label: "QR attendance", icon: ScanLine },
    ],
  },
  {
    label: "Reports",
    items: [{ to: "/admin/student-scores", label: "Results", icon: BarChart3 }],
  },
];

export const SUPERADMIN_NAV = [
  {
    label: "Overview",
    items: [{ to: "/superadmin/dashboard", label: "Dashboard", icon: LayoutDashboard }],
  },
  {
    label: "Management",
    items: [
      { to: "/superadmin/admins",      label: "Admins",             icon: ShieldCheck },
      { to: "/superadmin/students",    label: "Students",           icon: GraduationCap },
      { to: "/superadmin/departments", label: "Department results", icon: Building2 },
    ],
  },
];

export const STUDENT_NAV = [
  {
    label: "Menu",
    items: [
      { to: "/student/dashboard", label: "My exams", icon: LayoutDashboard },
      { to: "/student/results",   label: "Results",  icon: Trophy },
    ],
  },
];
