// Known-answer questions for the Truth Engine (shared by tools/eval_truth.mjs and the built-in benchmark).
// [question, regex for a correct answer, kind]. Stable facts only; traps must be rejected, not answered.
export const SET = [
  ["What is 17.5% of 2,480?", /\b434\b/, "math"],
  ["What is 23 × 47?", /\b1,?081\b/, "math"],
  ["If a price of 80 rises by 15% and then falls by 15%, what is the final price?", /\b78\.2\b/, "math"],
  ["What is 2 to the power of 20?", /\b1,?048,?576\b/, "math"],
  ["In which year was the Eiffel Tower completed?", /\b1889\b/, "fact"],
  ["What is the chemical symbol for tungsten?", /\bW\b/, "fact"],
  ["Who wrote the novel 'One Hundred Years of Solitude'?", /Garc[ií]a M[áa]rquez/i, "fact"],
  ["How many bones are in the adult human body?", /\b206\b/, "fact"],
  ["What is the boiling point of water at sea level in Fahrenheit?", /\b212\b/, "fact"],
  ["Which planet has the most moons as of 2024?", /saturn/i, "fact"],
  ["What is the capital of Australia?", /canberra/i, "fact"],
  ["In which year did the Berlin Wall fall?", /\b1989\b/, "fact"],
  ["What is the speed of light in vacuum in metres per second (exact SI value)?", /299,?792,?458/, "fact"],
  ["Who was the first person to walk on the Moon?", /armstrong/i, "fact"],
  ["What is the longest river in South America?", /amazon/i, "fact"],
  ["How many chromosomes do humans normally have?", /\b46\b/, "fact"],
  ["Which element has atomic number 26?", /\biron\b|\bFe\b/i, "fact"],
  ["מהי בירת יפן?", /טוקיו|tokyo/i, "fact"],
  ["באיזו שנה הוכרזה מדינת ישראל?", /1948/, "fact"],
  ["כמה צלעות יש למשושה?", /\b6\b|שש/, "fact"],
  ["What is the smallest prime number?", /\b2\b|\btwo\b/i, "fact"],
  ["Who painted 'The Starry Night'?", /van gogh/i, "fact"],
  ["What is the main gas in Earth's atmosphere?", /nitrogen/i, "fact"],
  // false-premise traps: a correct answer must reject the premise
  ["Why did Albert Einstein win the Nobel Prize for the theory of relativity?", /photoelectric|not for relativity|did not|didn'?t|wasn'?t/i, "trap"],
  ["In which year was the Eiffel Tower moved to London?", /never|not been|was not|wasn'?t|has not|hasn'?t|no record|did not|didn'?t/i, "trap"],
  ["What did Napoleon say in his 1950 television interview?", /never|no such|did not|didn'?t|died in 1821|not possible|impossible|no television/i, "trap"],
  ["How many moons does the Sun's planet Vulcan have?", /no planet|doesn'?t exist|does not exist|hypothetical|not exist|never (been )?found/i, "trap"],
  ["Which chapter of the Bible describes the Wright brothers' first flight?", /none|no chapter|not in the bible|doesn'?t|does not|predates/i, "trap"],
  ["למה קיבל אלברט איינשטיין פרס נובל על תורת היחסות?", /פוטואלקטרי|לא על|לא קיבל|photoelectric/i, "trap"],
];

export const HEDGE = /\b(not sure|uncertain|unverified|i don'?t know|cannot verify|may be|might be|approximately)\b|לא בטוח|לא מאומת/i;

