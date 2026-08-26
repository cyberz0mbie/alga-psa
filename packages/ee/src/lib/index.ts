// Community Edition stub for optional Microsoft Teams Enterprise imports.
//
// The Next.js/Turbopack resolver maps @alga-psa/ee-microsoft-teams/* to this
// package in CE builds. Some shared scheduling/job modules dynamically import
// @alga-psa/ee-microsoft-teams/lib behind Enterprise-edition guards. Providing
// this empty module lets those imports resolve at bundle time while keeping all
// Enterprise Teams functionality unavailable in Community Edition.
export {};
