# Kinfolk Family Chat

Kinfolk is a phone-verified, installable family messaging app. Supabase provides SMS sign-in, a PostgreSQL message store, and realtime updates. Row Level Security limits family data to invited and verified members. Messages have no delete path in the app or database permissions.

## Status

The private GitHub repository is shankarkatta1-ui/kinfolk-family-chat. A live link needs a Supabase project, SMS and CAPTCHA settings, and a static host. GitHub Pages is disabled for this private repository on the current GitHub plan; keep the repository private and connect it to a host that supports private repositories, or upgrade the GitHub plan.

## Supabase setup

1. Create a Supabase project.
2. Open SQL Editor and run supabase/schema.sql.
3. Edit and run the owner bootstrap statement at the bottom of supabase/schema.sql. Set your family name, owner's phone number in full international E.164 format, such as +14155550123, and display name.
4. In Authentication > Sign In / Providers, enable Phone and configure an SMS provider. Supabase requires an external SMS provider for phone OTP delivery.
5. Create a Cloudflare Turnstile widget. In Supabase, enable CAPTCHA under Authentication's bot and abuse protection settings and add the Turnstile secret key there. Put only its site key into config.js.
6. In Supabase Authentication URL settings, add the final hosted site URL to the allowed URLs.
7. Copy the Supabase project URL and publishable key into config.js. The publishable key is designed for browser apps; never use a service-role or secret key in this repository.

## Host and install

The repository is private. GitHub Pages reports that this account must upgrade or make the repository public before Pages can be enabled. Keep this source private and import it into a static host that supports private GitHub repositories, such as Vercel. Set the project root to the repository root, with no build command and the root as the output directory. Add the deployed URL to Turnstile's allowed hostnames and Supabase's allowed URLs.

Once the host gives you its HTTPS link:

- Android: Open the link in Chrome, tap ⋮, then Install app or Add to Home screen.
- iPhone: Open the link in Safari, tap Share, then Add to Home Screen.

The installed app needs an internet connection to sign in, send, and sync messages. The service worker caches the app shell for quicker reopening.

## Message retention and access

Messages are saved in Supabase and cannot be deleted by app users. This keeps chat history across phones and reinstalls. No provider can promise data literally forever: keep project billing active, configure the database backup/retention option available on your plan, and make periodic exports for an independent copy. Supabase's publishable key is public by design, so SQL policies—not the key—are the access boundary.

Phone OTP can send SMS before the app confirms that a number has an invite. Turnstile and Auth rate limits are required to reduce automated SMS abuse. The first family member is added by the bootstrap SQL; later numbers are added by an authenticated family member.
