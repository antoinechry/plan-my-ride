// E-mail d'avertissement avant suppression d'un compte inactif (même mise en page que les e-mails de bienvenue).
const F = 'font-family:Arial,Helvetica,sans-serif;';
const SITE = 'https://sillage-ride.eu';
const APP = 'https://antoinechry.github.io/plan-my-ride/';
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function shell(lang: string, pre: string, title: string, inner: string, foot: string) {
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head>
<body style="margin:0;padding:0;background:#F1F3F0">
<div style="display:none;max-height:0;overflow:hidden">${pre}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F1F3F0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px">
<tr><td style="padding:0 8px 20px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="padding-right:10px"><img src="${SITE}/img/sillage-mail.png" width="40" height="40" alt="" style="display:block;border:0;border-radius:10px"></td>
<td style="${F}font-size:24px;font-weight:800;letter-spacing:-0.5px;color:#14201B">Sillage</td>
</tr></table></td></tr>
<tr><td bgcolor="#FFFFFF" style="border-radius:20px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td style="padding:32px 32px 8px;${F}font-size:24px;line-height:1.25;font-weight:800;color:#14201B">${title}</td></tr>
${inner}
</table></td></tr>
<tr><td style="padding:20px 8px 0;${F}font-size:12px;line-height:1.5;color:#4C5852">${foot}</td></tr>
</table></td></tr></table></body></html>`;
}
const p = (t: string, pad = '8px 32px 16px') => `<tr><td style="padding:${pad};${F}font-size:16px;line-height:1.55;color:#14201B">${t}</td></tr>`;
const btn = (label: string, url: string) => `<tr><td style="padding:8px 32px 32px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#E0A21B" style="border-radius:999px"><a href="${url}" style="display:inline-block;padding:14px 26px;${F}font-size:16px;font-weight:bold;color:#14201B;text-decoration:none;border-radius:999px">${label}</a></td></tr></table></td></tr>`;
const box = (t: string) => `<tr><td style="padding:0 32px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#FBF1DA" style="border-radius:14px;padding:16px 18px;border-left:4px solid #E0A21B;${F}font-size:16px;line-height:1.5;color:#14201B">${t}</td></tr></table></td></tr>`;

export function warningMail(lang: string, prenom: string, deleteOn: Date) {
  if (lang === 'en') {
    const d = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' }).format(deleteOn);
    return {
      subject: 'Your Sillage account will be deleted in a month · Sillage',
      html: shell('en', `Sign in before ${d} to keep your routes.`, prenom ? `Hi ${esc(prenom)},` : 'Hi,',
        p('You have not used Sillage for almost 3 years. To respect your data, we delete inactive accounts.') +
        box(`<strong>On ${d}</strong>, your account, routes and weather alerts will be erased for good.`) +
        p('<strong>Want to keep them?</strong> Just open Sillage and sign in before that date. That is all.') +
        p('No longer interested? You have nothing to do: everything will be deleted automatically.', '0 32px 16px') +
        btn('Open Sillage', APP),
        `Sillage · Weather along your route.<br><a href="${SITE}/en/privacy/" style="color:#4C5852">Privacy</a> · <a href="mailto:hello@sillage-ride.eu" style="color:#4C5852">hello@sillage-ride.eu</a><br>You receive this e-mail because you have a Sillage account.`),
    };
  }
  const d = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' }).format(deleteOn);
  return {
    subject: 'Ton compte Sillage sera supprimé dans un mois · Sillage',
    html: shell('fr', `Connecte-toi avant le ${d} pour garder tes parcours.`, prenom ? `Bonjour ${esc(prenom)},` : 'Bonjour,',
      p('Tu n\'as pas utilisé Sillage depuis près de 3 ans. Pour respecter tes données, on supprime les comptes inactifs.') +
      box(`<strong>Le ${d}</strong>, ton compte, tes parcours et tes alertes météo seront effacés définitivement.`) +
      p('<strong>Tu veux les garder ?</strong> Ouvre simplement Sillage et connecte-toi avant cette date. C\'est tout.') +
      p('Sillage ne te sert plus ? Tu n\'as rien à faire : tout sera supprimé automatiquement.', '0 32px 16px') +
      btn('Ouvrir Sillage', APP),
      `Sillage · La météo sur ta trace.<br><a href="${SITE}/confidentialite/" style="color:#4C5852">Confidentialité</a> · <a href="mailto:hello@sillage-ride.eu" style="color:#4C5852">hello@sillage-ride.eu</a><br>Tu reçois cet e-mail car tu as un compte Sillage.`),
  };
}
