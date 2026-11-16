/**
 * Approved driver names: Hindu first names and surnames (common across Gujarat and North India).
 * Every driver created in JeevanSetu must have a first name from FIRST_NAMES and a surname from
 * SURNAMES. The admin "Add driver" form suggests names from these lists, and the server rejects any
 * other name. Pure module: safe to import from client and server code.
 */
export const FIRST_NAMES = [
  "Ramesh", "Suresh", "Rakesh", "Mahesh", "Dinesh", "Nilesh", "Hitesh", "Ketan", "Hiren", "Dharmesh",
  "Jaydip", "Mayur", "Parth", "Dhaval", "Nirav", "Chirag", "Bhargav", "Kalpesh", "Yogesh", "Mitesh",
  "Pravin", "Rajesh", "Sanjay", "Vishal", "Hardik", "Jatin", "Kiran", "Hetal", "Jignesh", "Bhavesh",
  "Pankaj", "Harsh", "Kunal", "Tushar", "Vikram", "Akshay", "Manish", "Deepak", "Ashok", "Girish",
  "Naresh", "Paresh", "Pratik", "Nikunj", "Sagar", "Ravi", "Anil", "Sunil", "Mukesh", "Dilip",
  "Jayesh", "Kaushik", "Mehul", "Nitin", "Rohit", "Sachin", "Umesh", "Vipul", "Yash", "Dipak",
];

export const SURNAMES = [
  "Patel", "Shah", "Joshi", "Trivedi", "Desai", "Rana", "Thakor", "Thakkar", "Rawal", "Bhatt", "Vyas",
  "Pandya", "Mehta", "Dave", "Parmar", "Solanki", "Chauhan", "Makwana", "Gohil", "Jadeja", "Modi",
  "Vasava", "Rathod", "Raval", "Soni", "Sharma", "Mishra", "Tiwari", "Dubey", "Pathak", "Upadhyay",
  "Dwivedi", "Prajapati", "Barot", "Brahmbhatt", "Oza", "Bhavsar", "Gandhi", "Vaghela", "Zala", "Dabhi",
  "Gadhvi", "Yadav", "Kshatriya", "Chavda", "Sisodiya", "Maheta",
];

const firstSet = new Set(FIRST_NAMES.map((n) => n.toLowerCase()));
const surnameSet = new Set(SURNAMES.map((n) => n.toLowerCase()));

/** True when the name is "<approved first name> <approved surname>". */
export function isHindiName(name: string): boolean {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return false;
  return firstSet.has(parts[0].toLowerCase()) && surnameSet.has(parts[parts.length - 1].toLowerCase());
}

/** A random approved name (for the "Suggest name" button). */
export function suggestHindiName(exclude: string[] = []): string {
  const taken = new Set(exclude.map((n) => n.toLowerCase()));
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const first = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
    const last = SURNAMES[Math.floor(Math.random() * SURNAMES.length)];
    const candidate = `${first} ${last}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${FIRST_NAMES[0]} ${SURNAMES[0]}`;
}
