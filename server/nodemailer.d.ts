// nodemailer ships no types and is only dynamically imported when SMTP_HOST is
// set (see email.ts). A loose module declaration keeps the typecheck clean
// without pulling in @types/nodemailer as a dependency.
declare module 'nodemailer';
