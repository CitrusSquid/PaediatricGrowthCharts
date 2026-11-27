export const bpRecommendations = {
    normal: {
        title: 'Normal BP',
        points: [
            'No additional action is needed.',
            'BP should be rechecked at the next routine visit.'
        ]
    },
    elevated: {
        title: 'Elevated BP',
        points: [
            'Initial:',
            '- Lifestyle interventions (nutrition, sleep, physical activity)',
            '- BP rechecked in 6 months',
            'If BP remains elevated at 6 months:',
            '- Upper and lower extremity BP',
            '- Lifestyle measures.',
            'If BP still elevated after 12 months from initial measurement:',
            '- ABPM',
            '- Diagnostic evaluation',
            '- Subspecialty referral.'
        ]
    },
    stage1: {
        title: 'Stage 1 Hypertension',
        points: [
            'If asymptomatic:',
            '- Lifestyle interventions (nutrition, sleep, physical activity)',
            '- BP rechecked in 1-2 weeks',
            'If BP remains classified as Stage 1 HTN at 1-2 weeks:',
            '- Upper and lower extremity BP',
            '- BP should be checked in 3 months',
            '- Consideration for nutrition/weight management referral.',
            'If BP continues to be classified as Stage 1 HTN after 3 visits:',
            '- ABPM',
            '- Diagnostic evaluation',
            '- Antihypertensives',
            '- Consideration for subspecialty referral.'
        ]
    },
    stage2: {
        title: 'Stage 2 Hypertension',
        points: [
            'If asymptomatic:',
            '- Lifestyle interventions (nutrition, sleep, physical activity)',
            '- BP rechecked in 1 week OR subspecialist referral within 1 week.',
            'If BP remains classified as Stage 2 HTN at 1 week:',
            '- ABPM',
            '- Diagnostic evaluation',
            '- Antihypertensives',
            '- Consider subspeciality referral within 1 week.',
            'Additional note: Sports limitation - LVH, or any athlete with stage 2 hypertension until controlled.'
        ]
    },
    critical: {
        title: 'Critical Actions',
        points: [
            'If symptomatic or end organ damage with Stage 2 HTN level OR the BP is >30 mmHg above the 95th percentile (or >180/120 mmHg in an adolescent):',
            'Refer to emergency department immediately for evaluation and treatment of acute severe HTN.'
        ]
    }
};
