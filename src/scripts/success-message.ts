/**
 * Fills the optional {email} token in site.contact.successMessage with the address the visitor
 * submitted. The replacement is a function, so "$&" or "$1" in an address stays literal.
 */
export function successText(message: string, email: string): string {
  return message.replaceAll('{email}', () => email);
}
